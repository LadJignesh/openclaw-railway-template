// OpenClaw Railway Template — Main Server
// Modular architecture with structured logging, circuit breakers,
// metrics, alerting, and proper process management.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import express from "express";
import pty from "node-pty";
import { WebSocketServer } from "ws";

// ═══ Internal Modules ═══
import { createLogger, generateCorrelationId, withCorrelation } from "./lib/logger.js";
import { runCmd } from "./lib/run-cmd.js";
import { redactSecrets, setGatewayToken } from "./lib/redact.js";
import { rateLimitMiddleware, TokenBucketLimiter } from "./lib/rate-limiter.js";
import { alerts, AlertType } from "./lib/alerts.js";
import { registry as metricsRegistry, httpRequestsTotal, httpRequestDuration, gatewayStatus } from "./lib/metrics.js";

import { GatewayManager } from "./gateway/lifecycle.js";
import { resolveGatewayToken } from "./gateway/token.js";
import { createProxy } from "./gateway/proxy.js";
import { createSetupAuth, verifyTuiAuth } from "./auth/middleware.js";

import { registerSmartRouterRoutes, getSmartRouterInstance } from "./smart-router/routes.js";
import { buildAutoSetupPayload, detectProvider, detectNvidia } from "./auto-setup.js";

const log = createLogger("server");

// ═══════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════

const PORT = Number.parseInt(process.env.PORT ?? "8080", 10);
const STATE_DIR = process.env.OPENCLAW_STATE_DIR?.trim() || path.join(os.homedir(), ".openclaw");
const WORKSPACE_DIR = process.env.OPENCLAW_WORKSPACE_DIR?.trim() || path.join(STATE_DIR, "workspace");
const SETUP_PASSWORD = process.env.SETUP_PASSWORD?.trim();
const INTERNAL_GATEWAY_PORT = Number.parseInt(process.env.INTERNAL_GATEWAY_PORT ?? "18789", 10);
const INTERNAL_GATEWAY_HOST = process.env.INTERNAL_GATEWAY_HOST ?? "127.0.0.1";
const OPENCLAW_ENTRY = process.env.OPENCLAW_ENTRY?.trim() || "/openclaw/dist/entry.js";
const OPENCLAW_NODE = process.env.OPENCLAW_NODE?.trim() || "node";
const ENABLE_WEB_TUI = process.env.ENABLE_WEB_TUI?.toLowerCase() === "true";
const TUI_IDLE_TIMEOUT_MS = Number.parseInt(process.env.TUI_IDLE_TIMEOUT_MS ?? "300000", 10);
const TUI_MAX_SESSION_MS = Number.parseInt(process.env.TUI_MAX_SESSION_MS ?? "1800000", 10);

// Security warnings
if (SETUP_PASSWORD && SETUP_PASSWORD.length < 12) {
  log.warn("SETUP_PASSWORD is shorter than 12 characters — use a stronger password for production");
}
if (!SETUP_PASSWORD) {
  log.warn("SETUP_PASSWORD is not set — /setup wizard will be inaccessible");
}

// ═══════════════════════════════════════════════════════════════════════
// GATEWAY SETUP
// ═══════════════════════════════════════════════════════════════════════

const OPENCLAW_GATEWAY_TOKEN = resolveGatewayToken(STATE_DIR);
process.env.OPENCLAW_GATEWAY_TOKEN = OPENCLAW_GATEWAY_TOKEN;
setGatewayToken(OPENCLAW_GATEWAY_TOKEN);

const gateway = new GatewayManager({
  stateDir: STATE_DIR,
  workspaceDir: WORKSPACE_DIR,
  internalPort: INTERNAL_GATEWAY_PORT,
  internalHost: INTERNAL_GATEWAY_HOST,
  gatewayToken: OPENCLAW_GATEWAY_TOKEN,
  openclawNode: OPENCLAW_NODE,
  openclawEntry: OPENCLAW_ENTRY,
});

const proxy = createProxy({
  target: gateway.target,
  gatewayToken: OPENCLAW_GATEWAY_TOKEN,
});

// Helper to run openclaw CLI commands
function clawArgs(args) { return [OPENCLAW_ENTRY, ...args]; }

function clawCmd(args, opts = {}) {
  return runCmd(OPENCLAW_NODE, clawArgs(args), {
    env: { OPENCLAW_STATE_DIR: STATE_DIR, OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR },
    ...opts,
  });
}

// ═══════════════════════════════════════════════════════════════════════
// CACHED INFO
// ═══════════════════════════════════════════════════════════════════════

let cachedOpenclawVersion = null;
let cachedChannelsHelp = null;

async function getOpenclawInfo() {
  if (!cachedOpenclawVersion) {
    const [version, channelsHelp] = await Promise.all([
      clawCmd(["--version"]),
      clawCmd(["channels", "add", "--help"]),
    ]);
    cachedOpenclawVersion = version.output.trim();
    cachedChannelsHelp = channelsHelp.output;
  }
  return { version: cachedOpenclawVersion, channelsHelp: cachedChannelsHelp };
}

// ═══════════════════════════════════════════════════════════════════════
// EXPRESS APP
// ═══════════════════════════════════════════════════════════════════════

const app = express();
app.disable("x-powered-by");

// Security headers
app.use((_req, res, next) => {
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  if (process.env.RAILWAY_PUBLIC_DOMAIN) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  if (_req.path.startsWith("/setup") || _req.path === "/tui") {
    res.setHeader("Content-Security-Policy", [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://unpkg.com",
      "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: https://raw.githubusercontent.com",
      "connect-src 'self'",
      "frame-ancestors 'self'",
    ].join("; "));
  }
  return next();
});

// Request metrics middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const duration = (Date.now() - start) / 1000;
    const p = req.path.split("/").slice(0, 3).join("/"); // normalize path depth
    httpRequestsTotal.inc({ method: req.method, path: p, status: String(res.statusCode) });
    httpRequestDuration.observe({ method: req.method, path: p }, duration);
  });
  return next();
});

app.use(express.json({ limit: "1mb" }));

const requireSetupAuth = createSetupAuth(SETUP_PASSWORD);

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC ENDPOINTS (no auth)
// ═══════════════════════════════════════════════════════════════════════

const publicLimiter = rateLimitMiddleware({ maxTokens: 30, refillRate: 3 });

app.get("/healthz", publicLimiter, async (_req, res) => {
  let gw = "unconfigured";
  if (gateway.isConfigured) {
    gw = gateway.isReady ? "ready" : "starting";
  }
  res.json({ ok: true, gateway: gw });
});

// Prometheus metrics endpoint
app.get("/metrics", publicLimiter, (_req, res) => {
  gatewayStatus.set({}, gateway.isReady ? 1 : 0);
  res.type("text/plain; version=0.0.4; charset=utf-8").send(metricsRegistry.serialize());
});

// ═══════════════════════════════════════════════════════════════════════
// SETUP ENDPOINTS (auth required)
// ═══════════════════════════════════════════════════════════════════════

app.get("/setup/healthz", (_req, res) => res.json({ ok: true }));

// Smart Router API
registerSmartRouterRoutes(app);

app.get("/setup/logout", (_req, res) => {
  res.set("WWW-Authenticate", 'Basic realm="OpenClaw Setup"');
  res.set("Clear-Site-Data", '"cookies"');
  return res.status(401).type("text/html").send(
    '<!doctype html><html><head><meta charset="utf-8"><title>Signed Out</title></head>' +
    '<body style="font-family:system-ui;text-align:center;padding:80px 20px;background:#0a0a0a;color:#e5e5e5">' +
    '<h2>Signed out of OpenClaw Setup</h2>' +
    '<p style="color:#737373;margin:12px 0 24px">Your browser credentials have been cleared.</p>' +
    '<a href="/setup" style="color:#a855f7;text-decoration:underline">Sign in again</a></body></html>'
  );
});

app.get("/setup", requireSetupAuth, (_req, res) => {
  res.sendFile(path.join(process.cwd(), "src", "public", "dashboard.html"));
});

app.get("/setup/api/status", requireSetupAuth, async (_req, res) => {
  const { version, channelsHelp } = await getOpenclawInfo();

  const authGroups = [
    { value: "openai", label: "OpenAI", hint: "Codex OAuth + API key", options: [
      { value: "codex-cli", label: "OpenAI Codex OAuth (Codex CLI)" },
      { value: "openai-codex", label: "OpenAI Codex (ChatGPT OAuth)" },
      { value: "openai-api-key", label: "OpenAI API key" },
    ]},
    { value: "anthropic", label: "Anthropic", hint: "Claude Code CLI + API key", options: [
      { value: "claude-cli", label: "Anthropic token (Claude Code CLI)" },
      { value: "token", label: "Anthropic token (paste setup-token)" },
      { value: "apiKey", label: "Anthropic API key" },
    ]},
    { value: "google", label: "Google", hint: "Gemini API key + OAuth", options: [
      { value: "gemini-api-key", label: "Google Gemini API key" },
      { value: "google-antigravity", label: "Google Antigravity OAuth" },
      { value: "google-gemini-cli", label: "Google Gemini CLI OAuth" },
    ]},
    { value: "openrouter", label: "OpenRouter", hint: "API key", options: [
      { value: "openrouter-api-key", label: "OpenRouter API key" },
    ]},
    { value: "ai-gateway", label: "Vercel AI Gateway", hint: "API key", options: [
      { value: "ai-gateway-api-key", label: "Vercel AI Gateway API key" },
    ]},
    { value: "moonshot", label: "Moonshot AI", hint: "Kimi K2 + Kimi Code", options: [
      { value: "moonshot-api-key", label: "Moonshot AI API key" },
      { value: "kimi-code-api-key", label: "Kimi Code API key" },
    ]},
    { value: "zai", label: "Z.AI (GLM 4.7)", hint: "API key", options: [
      { value: "zai-api-key", label: "Z.AI (GLM 4.7) API key" },
    ]},
    { value: "minimax", label: "MiniMax", hint: "M2.1 (recommended)", options: [
      { value: "minimax-api", label: "MiniMax M2.1" },
      { value: "minimax-api-lightning", label: "MiniMax M2.1 Lightning" },
    ]},
    { value: "qwen", label: "Qwen", hint: "OAuth", options: [
      { value: "qwen-portal", label: "Qwen OAuth" },
    ]},
    { value: "copilot", label: "Copilot", hint: "GitHub + local proxy", options: [
      { value: "github-copilot", label: "GitHub Copilot (GitHub device login)" },
      { value: "copilot-proxy", label: "Copilot Proxy (local)" },
    ]},
    { value: "synthetic", label: "Synthetic", hint: "Anthropic-compatible (multi-model)", options: [
      { value: "synthetic-api-key", label: "Synthetic API key" },
    ]},
    { value: "opencode-zen", label: "OpenCode Zen", hint: "API key", options: [
      { value: "opencode-zen", label: "OpenCode Zen (multi-model proxy)" },
    ]},
  ];

  const providerModels = {
    anthropic: [
      { value: "anthropic/claude-sonnet-4-20250514", label: "Claude Sonnet 4 (recommended)", tier: "mid" },
      { value: "anthropic/claude-3-5-sonnet-20241022", label: "Claude 3.5 Sonnet", tier: "mid" },
      { value: "anthropic/claude-3-5-haiku-20241022", label: "Claude 3.5 Haiku (budget)", tier: "low" },
      { value: "anthropic/claude-3-haiku-20250307", label: "Claude 3 Haiku (cheapest)", tier: "low" },
      { value: "anthropic/claude-3-opus-20250219", label: "Claude 3 Opus (premium)", tier: "high" },
    ],
    openai: [
      { value: "openai/gpt-4o", label: "GPT-4o (recommended)", tier: "mid" },
      { value: "openai/gpt-4o-mini", label: "GPT-4o Mini (budget)", tier: "low" },
      { value: "openai/o3-mini", label: "o3-mini (reasoning)", tier: "mid" },
    ],
    google: [
      { value: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro", tier: "mid" },
      { value: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash (budget)", tier: "low" },
    ],
    openrouter: [
      { value: "anthropic/claude-sonnet-4-20250514", label: "Claude Sonnet 4 (via OpenRouter)", tier: "mid" },
      { value: "openai/gpt-4o", label: "GPT-4o (via OpenRouter)", tier: "mid" },
      { value: "openai/gpt-4o-mini", label: "GPT-4o Mini (via OpenRouter)", tier: "low" },
    ],
    moonshot: [{ value: "moonshot/kimi-k2", label: "Kimi K2", tier: "mid" }],
    minimax: [
      { value: "minimax/m2.1", label: "MiniMax M2.1", tier: "mid" },
      { value: "minimax/m2.1-lightning", label: "MiniMax M2.1 Lightning", tier: "low" },
    ],
    nvidia: [
      { value: "qwen/qwen3.5-122b-a10b", label: "Qwen 3.5 122B MoE (recommended, free)", tier: "free" },
      { value: "nvidia/llama-3.3-nemotron-super-49b-v1", label: "Nemotron Super 49B (free)", tier: "free" },
      { value: "nvidia/llama-3.1-nemotron-ultra-253b-v1", label: "Nemotron Ultra 253B (free)", tier: "free" },
      { value: "deepseek-ai/deepseek-r1", label: "DeepSeek R1 (free, reasoning)", tier: "free" },
      { value: "meta/llama-3.1-405b-instruct", label: "Llama 3.1 405B (free)", tier: "free" },
    ],
  };

  const detectedProviders = [];
  if (process.env.ANTHROPIC_API_KEY) detectedProviders.push("anthropic");
  if (process.env.OPENAI_API_KEY) detectedProviders.push("openai");
  if (process.env.OPENROUTER_API_KEY) detectedProviders.push("openrouter");
  if (process.env.GOOGLE_CREDENTIALS_JSON || process.env.GEMINI_API_KEY) detectedProviders.push("google");
  if (process.env.MOONSHOT_API_KEY) detectedProviders.push("moonshot");
  if (process.env.MINIMAX_API_KEY) detectedProviders.push("minimax");
  if (process.env.NVIDIA_API_KEY) detectedProviders.push("nvidia");

  res.json({
    configured: gateway.isConfigured,
    gatewayTarget: gateway.target,
    openclawVersion: version,
    channelsAddHelp: channelsHelp,
    authGroups,
    tuiEnabled: ENABLE_WEB_TUI,
    providerModels,
    detectedProviders,
  });
});

// ═══════════════════════════════════════════════════════════════════════
// ONBOARDING
// ═══════════════════════════════════════════════════════════════════════

function buildOnboardArgs(payload) {
  const args = [
    "onboard", "--non-interactive", "--accept-risk", "--json",
    "--no-install-daemon", "--skip-health",
    "--workspace", WORKSPACE_DIR,
    "--gateway-bind", "loopback",
    "--gateway-port", String(INTERNAL_GATEWAY_PORT),
    "--gateway-auth", "token",
    "--gateway-token", OPENCLAW_GATEWAY_TOKEN,
    "--flow", payload.flow || "quickstart",
  ];

  if (payload.authChoice) {
    args.push("--auth-choice", payload.authChoice);
    const secret = (payload.authSecret || "").trim();
    const map = {
      "openai-api-key": "--openai-api-key", apiKey: "--anthropic-api-key",
      "openrouter-api-key": "--openrouter-api-key", "ai-gateway-api-key": "--ai-gateway-api-key",
      "moonshot-api-key": "--moonshot-api-key", "kimi-code-api-key": "--kimi-code-api-key",
      "gemini-api-key": "--gemini-api-key", "zai-api-key": "--zai-api-key",
      "minimax-api": "--minimax-api-key", "minimax-api-lightning": "--minimax-api-key",
      "synthetic-api-key": "--synthetic-api-key", "opencode-zen": "--opencode-zen-api-key",
    };
    const flag = map[payload.authChoice];
    if (flag && secret) args.push(flag, secret);
    if (payload.authChoice === "token" && secret) {
      args.push("--token-provider", "anthropic", "--token", secret);
    }
  }

  return args;
}

// ═══ MODEL AUTO-REGISTRATION ═══
// Syncs smart-router models into Openclaw's config so the agent knows about them.

async function registerSmartRouterModels() {
  const smartConfig = (await import("./smart-router/config.js")).default;
  const providers = [];

  // Register NVIDIA direct models if API key is set
  if (smartConfig.nvidiaApiKey) {
    const nvidiaModels = Object.values(smartConfig.nvidiaDirectModels).map((m) => m.id);
    providers.push({
      id: "nvidia",
      type: "openai",
      apiBase: "https://integrate.api.nvidia.com/v1",
      apiKeyEnv: "NVIDIA_API_KEY",
      models: nvidiaModels,
    });
    log.info("registering NVIDIA models with Openclaw", { count: nvidiaModels.length, models: nvidiaModels });
  }

  // Register OpenRouter free models if API key is set
  if (smartConfig.openrouterApiKey) {
    const orModels = Object.values(smartConfig.freeModels).map((m) => m.id);
    providers.push({
      id: "openrouter",
      type: "openai",
      apiBase: "https://openrouter.ai/api/v1",
      apiKeyEnv: "OPENROUTER_API_KEY",
      models: orModels,
    });
    log.info("registering OpenRouter models with Openclaw", { count: orModels.length });
  }

  // Register NVIDIA as a custom OpenAI-compatible provider (object format, not array)
  if (smartConfig.nvidiaApiKey) {
    const nvidiaProvider = {
      baseUrl: "https://integrate.api.nvidia.com/v1",
      apiKey: "NVIDIA_API_KEY",
      api: "openai-completions",
      models: [
        { id: "qwen/qwen3.5-122b-a10b", name: "Qwen 3.5 122B MoE", contextWindow: 32768, maxTokens: 4096, input: ["text"] },
        { id: "nvidia/llama-3.3-nemotron-super-49b-v1", name: "Nemotron Super 49B", contextWindow: 32768, maxTokens: 4096, input: ["text"] },
        { id: "nvidia/llama-3.1-nemotron-ultra-253b-v1", name: "Nemotron Ultra 253B", contextWindow: 32768, maxTokens: 4096, input: ["text"] },
        { id: "deepseek-ai/deepseek-r1", name: "DeepSeek R1", reasoning: true, contextWindow: 65536, maxTokens: 8192, input: ["text"] },
        { id: "meta/llama-3.1-405b-instruct", name: "Llama 3.1 405B", contextWindow: 131072, maxTokens: 4096, input: ["text"] },
      ],
    };

    const modelsConfig = { mode: "merge", providers: { nvidia: nvidiaProvider } };
    const result = await clawCmd(["config", "set", "--json", "models", JSON.stringify(modelsConfig)]);
    if (result.code !== 0) {
      log.warn("failed to register NVIDIA models", { exit: result.code, output: result.output?.slice(0, 200) });
    } else {
      log.info("NVIDIA models registered in Openclaw config");
    }

    // Set agent default model (prefix with provider name "nvidia/")
    await clawCmd(["config", "set", "--json", "agents.defaults.model", JSON.stringify({
      primary: "nvidia/qwen/qwen3.5-122b-a10b",
      fallbacks: ["nvidia/deepseek-ai/deepseek-r1", "nvidia/nvidia/llama-3.1-nemotron-ultra-253b-v1"],
    })]);

    // Register aliases for easy switching via /model
    const modelAliases = {
      "nvidia/qwen/qwen3.5-122b-a10b": { alias: "qwen" },
      "nvidia/nvidia/llama-3.3-nemotron-super-49b-v1": { alias: "nemotron-49b" },
      "nvidia/nvidia/llama-3.1-nemotron-ultra-253b-v1": { alias: "nemotron-ultra" },
      "nvidia/deepseek-ai/deepseek-r1": { alias: "deepseek" },
      "nvidia/meta/llama-3.1-405b-instruct": { alias: "llama-405b" },
    };
    await clawCmd(["config", "set", "--json", "agents.defaults.models", JSON.stringify(modelAliases)]);

    log.info("agent defaults set to NVIDIA models (qwen primary)");
  }

  // Register OpenRouter free models if API key is set
  if (smartConfig.openrouterApiKey) {
    const orModels = Object.values(smartConfig.freeModels).map((m) => ({
      id: m.id.replace(/:free$/, ""), name: m.name, contextWindow: 32768, maxTokens: 4096, input: ["text"],
    }));
    const orProvider = {
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "OPENROUTER_API_KEY",
      api: "openai-completions",
      models: orModels,
    };
    const result = await clawCmd(["config", "set", "--json", "models.providers.openrouter", JSON.stringify(orProvider)]);
    if (result.code !== 0) {
      log.warn("failed to register OpenRouter models", { exit: result.code, output: result.output?.slice(0, 200) });
    }
  }
}

// ═══ AUTO-SETUP ═══
let autoSetupRunning = false;
let autoSetupDone = false;

async function runAutoSetup() {
  if (autoSetupRunning || autoSetupDone || gateway.isConfigured) return;

  const payload = buildAutoSetupPayload();
  if (!payload) {
    log.error("no API key detected in environment for auto-setup");
    await alerts.alert(AlertType.AUTO_SETUP_FAILED, "No API key detected in environment");
    return;
  }

  autoSetupRunning = true;
  log.info("starting auto-setup", { provider: payload._provider.label });

  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

    const onboardArgs = buildOnboardArgs(payload);
    const onboard = await clawCmd(onboardArgs);
    log.info("onboarding completed", { exit: onboard.code, configured: gateway.isConfigured });

    if (onboard.code !== 0 || !gateway.isConfigured) {
      log.error("onboarding failed", { output: onboard.output?.slice(0, 500) });
      await alerts.alert(AlertType.AUTO_SETUP_FAILED, `Onboarding failed (exit=${onboard.code})`);
      return;
    }

    // Configure gateway settings
    await clawCmd(["config", "set", "gateway.controlUi.allowInsecureAuth", "true"]);
    await clawCmd(["config", "set", "gateway.auth.token", OPENCLAW_GATEWAY_TOKEN]);
    await clawCmd(["config", "set", "--json", "gateway.trustedProxies", '["127.0.0.1"]']);

    if (payload.model) {
      await clawCmd(["models", "set", payload.model]);
      log.info("default model set", { model: payload.model });
    }

    // Configure channels
    async function autoConfigChannel(name, cfgObj) {
      const r = await clawCmd(["config", "set", "--json", `channels.${name}`, JSON.stringify(cfgObj)]);
      log.info("channel configured", { channel: name, exit: r.code });
    }

    if (payload.telegramToken) {
      await autoConfigChannel("telegram", {
        enabled: true, dmPolicy: "pairing", botToken: payload.telegramToken,
        groupPolicy: "allowlist", streamMode: "partial",
      });
    }
    if (payload.discordToken) {
      await autoConfigChannel("discord", {
        enabled: true, token: payload.discordToken, groupPolicy: "allowlist", dm: { policy: "pairing" },
      });
    }
    if (payload.slackBotToken || payload.slackAppToken) {
      await autoConfigChannel("slack", {
        enabled: true, botToken: payload.slackBotToken || undefined, appToken: payload.slackAppToken || undefined,
      });
    }

    // NVIDIA provider (legacy auto-setup detection)
    const nvidia = detectNvidia();
    if (nvidia) {
      log.info("configuring NVIDIA provider", { models: nvidia.models.length });
      await clawCmd(["config", "set", "--json", "providers.nvidia", JSON.stringify({
        id: "nvidia", baseUrl: "https://integrate.api.nvidia.com/v1",
        apiKeyEnvVar: "NVIDIA_API_KEY", models: nvidia.models,
      })]);
    }

    // Register all smart-router models so Openclaw agent recognizes them
    await registerSmartRouterModels();

    log.info("starting gateway after auto-setup");
    await gateway.restart();
    autoSetupDone = true;
    log.info("auto-setup complete");
  } catch (err) {
    log.error("auto-setup error", err);
    await alerts.alert(AlertType.AUTO_SETUP_FAILED, err.message);
  } finally {
    autoSetupRunning = false;
  }
}

// ═══ Validation ═══
const VALID_FLOWS = ["quickstart", "advanced", "manual"];
const VALID_AUTH_CHOICES = [
  "codex-cli", "openai-codex", "openai-api-key", "claude-cli", "token", "apiKey",
  "gemini-api-key", "google-antigravity", "google-gemini-cli", "openrouter-api-key",
  "ai-gateway-api-key", "moonshot-api-key", "kimi-code-api-key", "zai-api-key",
  "minimax-api", "minimax-api-lightning", "qwen-portal", "github-copilot", "copilot-proxy",
  "synthetic-api-key", "opencode-zen",
];

function validatePayload(payload) {
  if (payload.flow && !VALID_FLOWS.includes(payload.flow)) return `Invalid flow: ${payload.flow}`;
  if (payload.authChoice && !VALID_AUTH_CHOICES.includes(payload.authChoice)) return `Invalid authChoice: ${payload.authChoice}`;
  for (const f of ["telegramToken", "discordToken", "slackBotToken", "slackAppToken", "authSecret", "model"]) {
    if (payload[f] !== undefined && typeof payload[f] !== "string") return `Invalid ${f}: must be a string`;
  }
  return null;
}

app.post("/setup/api/run", requireSetupAuth, async (req, res) => {
  try {
    if (gateway.isConfigured) {
      await gateway.ensureRunning();
      return res.json({ ok: true, output: "Already configured.\nUse Reset setup to rerun onboarding.\n" });
    }

    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

    const payload = req.body || {};
    const validationError = validatePayload(payload);
    if (validationError) return res.status(400).json({ ok: false, output: validationError });

    const onboard = await clawCmd(buildOnboardArgs(payload));
    let extra = `\n[setup] Onboarding exit=${onboard.code} configured=${gateway.isConfigured}\n`;
    const ok = onboard.code === 0 && gateway.isConfigured;

    if (ok) {
      await clawCmd(["config", "set", "gateway.controlUi.allowInsecureAuth", "true"]);
      await clawCmd(["config", "set", "gateway.auth.token", OPENCLAW_GATEWAY_TOKEN]);
      await clawCmd(["config", "set", "--json", "gateway.trustedProxies", '["127.0.0.1"]']);

      if (payload.model?.trim()) {
        const mr = await clawCmd(["models", "set", payload.model.trim()]);
        extra += `[models set] exit=${mr.code}\n`;
      }

      async function configureChannel(name, cfgObj) {
        const s = await clawCmd(["config", "set", "--json", `channels.${name}`, JSON.stringify(cfgObj)]);
        return `[${name} config] exit=${s.code}\n`;
      }

      if (payload.telegramToken?.trim()) {
        extra += await configureChannel("telegram", {
          enabled: true, dmPolicy: "pairing", botToken: payload.telegramToken.trim(),
          groupPolicy: "allowlist", streamMode: "partial",
        });
      }
      if (payload.discordToken?.trim()) {
        extra += await configureChannel("discord", {
          enabled: true, token: payload.discordToken.trim(), groupPolicy: "allowlist", dm: { policy: "pairing" },
        });
      }
      if (payload.slackBotToken?.trim() || payload.slackAppToken?.trim()) {
        extra += await configureChannel("slack", {
          enabled: true, botToken: payload.slackBotToken?.trim(), appToken: payload.slackAppToken?.trim(),
        });
      }

      // Register smart-router models so Openclaw agent recognizes them
      await registerSmartRouterModels();
      extra += "[setup] Smart-router models registered.\n";

      await gateway.restart();
      extra += "[setup] Gateway started.\n";
    }

    return res.status(ok ? 200 : 500).json({ ok, output: `${onboard.output}${extra}` });
  } catch (err) {
    log.error("/setup/api/run error", err);
    return res.status(500).json({ ok: false, output: `Internal error: ${String(err)}` });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// DEBUG CONSOLE
// ═══════════════════════════════════════════════════════════════════════

const ALLOWED_CONSOLE_COMMANDS = new Set([
  "gateway.restart", "gateway.stop", "gateway.start",
  "openclaw.version", "openclaw.status", "openclaw.health",
  "openclaw.doctor", "openclaw.logs.tail", "openclaw.config.get",
  "openclaw.config.set", "openclaw.config.set.json",
  "openclaw.devices.list", "openclaw.devices.approve",
  "openclaw.plugins.list", "openclaw.plugins.enable",
]);

app.post("/setup/api/console/run", requireSetupAuth, async (req, res) => {
  try {
    const { command, arg } = req.body || {};
    if (!command || !ALLOWED_CONSOLE_COMMANDS.has(command)) {
      return res.status(400).json({ ok: false, error: `Command not allowed: ${command || "(empty)"}` });
    }

    let result;

    if (command === "gateway.restart") { await gateway.restart(); result = { code: 0, output: "Gateway restarted\n" }; }
    else if (command === "gateway.stop") { await gateway.stop(); result = { code: 0, output: "Gateway stopped\n" }; }
    else if (command === "gateway.start") { await gateway.ensureRunning(); result = { code: 0, output: "Gateway started\n" }; }
    else if (command === "openclaw.version") { result = await clawCmd(["--version"]); }
    else if (command === "openclaw.status") { result = await clawCmd(["status"]); }
    else if (command === "openclaw.health") { result = await clawCmd(["health"]); }
    else if (command === "openclaw.doctor") { result = await clawCmd(["doctor"]); }
    else if (command === "openclaw.logs.tail") {
      const count = arg?.trim() || "50";
      if (!/^\d+$/.test(count)) return res.status(400).json({ ok: false, error: "Invalid tail count" });
      result = await clawCmd(["logs", "--tail", count]);
    }
    else if (command === "openclaw.config.get") {
      if (!arg?.trim()) return res.status(400).json({ ok: false, error: "Config path required" });
      result = await clawCmd(["config", "get", arg.trim()]);
    }
    else if (command === "openclaw.config.set") {
      // arg format: "key value" e.g. "gateway.auth.token mytoken"
      const parts = arg?.trim()?.split(/\s+/);
      if (!parts || parts.length < 2) return res.status(400).json({ ok: false, error: "Usage: key value" });
      const [key, ...rest] = parts;
      result = await clawCmd(["config", "set", key, rest.join(" ")]);
    }
    else if (command === "openclaw.config.set.json") {
      // arg format: "key {json}" e.g. 'models {"mode":"merge",...}'
      const spaceIdx = arg?.trim()?.indexOf(" ");
      if (!arg || spaceIdx === -1) return res.status(400).json({ ok: false, error: "Usage: key {json}" });
      const key = arg.trim().slice(0, spaceIdx);
      const jsonVal = arg.trim().slice(spaceIdx + 1);
      try { JSON.parse(jsonVal); } catch { return res.status(400).json({ ok: false, error: "Invalid JSON value" }); }
      result = await clawCmd(["config", "set", "--json", key, jsonVal]);
    }
    else if (command === "openclaw.devices.list") { result = await clawCmd(["devices", "list"]); }
    else if (command === "openclaw.devices.approve") {
      if (!arg?.trim()) return res.status(400).json({ ok: false, error: "Device requestId required" });
      if (!/^[A-Za-z0-9_-]+$/.test(arg.trim())) return res.status(400).json({ ok: false, error: "Invalid requestId" });
      result = await clawCmd(["devices", "approve", arg.trim()]);
    }
    else if (command === "openclaw.plugins.list") { result = await clawCmd(["plugins", "list"]); }
    else if (command === "openclaw.plugins.enable") {
      if (!arg?.trim()) return res.status(400).json({ ok: false, error: "Plugin name required" });
      if (!/^[A-Za-z0-9_-]+$/.test(arg.trim())) return res.status(400).json({ ok: false, error: "Invalid plugin name" });
      result = await clawCmd(["plugins", "enable", arg.trim()]);
    }
    else { return res.status(500).json({ ok: false, error: "Command not implemented" }); }

    return res.json({ ok: result.code === 0, output: redactSecrets(result.output || ""), exitCode: result.code });
  } catch (err) {
    log.error("console/run error", err);
    return res.status(500).json({ ok: false, error: `Internal error: ${String(err)}` });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// CONFIG EDITOR
// ═══════════════════════════════════════════════════════════════════════

app.get("/setup/api/config/raw", requireSetupAuth, async (_req, res) => {
  try {
    const configPath = path.join(STATE_DIR, "openclaw.json");
    const raw = fs.readFileSync(configPath, "utf8");
    return res.json({ ok: true, config: raw });
  } catch (err) {
    return res.status(404).json({ ok: false, error: `Config not found: ${err.code || err.message}` });
  }
});

app.post("/setup/api/config/raw", requireSetupAuth, async (req, res) => {
  try {
    const { config: rawConfig } = req.body || {};
    if (!rawConfig || typeof rawConfig !== "string") {
      return res.status(400).json({ ok: false, error: "config field required (string)" });
    }
    if (rawConfig.length > 500_000) {
      return res.status(400).json({ ok: false, error: "Config too large (max 500KB)" });
    }

    // Validate JSON
    try { JSON.parse(rawConfig); } catch (e) {
      return res.status(400).json({ ok: false, error: `Invalid JSON: ${e.message}` });
    }

    const configPath = path.join(STATE_DIR, "openclaw.json");

    // Create timestamped backup
    try {
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      fs.copyFileSync(configPath, `${configPath}.bak-${ts}`);
    } catch { /* no existing config to backup */ }

    fs.writeFileSync(configPath, rawConfig, { encoding: "utf8", mode: 0o600 });
    log.info("config saved via editor");

    // Restart gateway to apply
    await gateway.restart();

    return res.json({ ok: true });
  } catch (err) {
    log.error("config/raw save error", err);
    return res.status(500).json({ ok: false, error: `Save failed: ${err.message}` });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// DEBUG INFO
// ═══════════════════════════════════════════════════════════════════════

app.get("/setup/api/debug", requireSetupAuth, async (_req, res) => {
  const v = await clawCmd(["--version"]);
  const help = await clawCmd(["channels", "add", "--help"]);
  res.json({
    wrapper: {
      node: process.version, port: PORT, stateDir: STATE_DIR,
      workspaceDir: WORKSPACE_DIR, configPath: gateway.configPath,
      gatewayTokenFromEnv: Boolean(process.env.OPENCLAW_GATEWAY_TOKEN?.trim()),
      railwayCommit: process.env.RAILWAY_GIT_COMMIT_SHA || null,
    },
    openclaw: {
      entry: OPENCLAW_ENTRY, node: OPENCLAW_NODE,
      version: v.output.trim(),
      channelsAddHelpIncludesTelegram: help.output.includes("telegram"),
    },
    gateway: gateway.getStatus(),
    alerts: { configured: alerts.isConfigured(), recentAlerts: alerts.getHistory().slice(-10) },
  });
});

// ═══════════════════════════════════════════════════════════════════════
// CONFIG MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════

const CONFIG_DIR = path.join(process.cwd(), "config");

function loadMainConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, "main.json"), "utf8"));
  } catch (err) {
    log.warn("could not load config/main.json", { error: err.code || err.message });
    return null;
  }
}

// ═══ In-memory cost tracker for swarm/proxy traffic ═══
const costTracker = {
  dailySpendUsd: 0, lastResetDate: new Date().toISOString().slice(0, 10),
  alertSent: false, modelStats: {}, routingStats: {}, hourlySpend: [], startedAt: Date.now(),

  _ensureModel(model) { if (!this.modelStats[model]) this.modelStats[model] = { requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }; },
  _currentHourKey() { return new Date().toISOString().slice(11, 13); },

  reset() {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.lastResetDate) {
      log.info("daily cost reset", { spent: this.dailySpendUsd, date: this.lastResetDate });
      this.dailySpendUsd = 0; this.lastResetDate = today; this.alertSent = false;
      this.modelStats = {}; this.routingStats = {}; this.hourlySpend = [];
    }
  },

  record(model, inputTokens, outputTokens, mainConfig) {
    this.reset();
    this._ensureModel(model);
    const stats = this.modelStats[model];
    stats.requests++; stats.inputTokens += inputTokens; stats.outputTokens += outputTokens;
    const rates = mainConfig?.costTracking?.models?.[model];
    let cost = 0;
    if (rates) cost = (inputTokens / 1_000_000) * (rates.inputPer1M || 0) + (outputTokens / 1_000_000) * (rates.outputPer1M || 0);
    stats.costUsd += cost; this.dailySpendUsd += cost;

    const hk = this._currentHourKey();
    let hourEntry = this.hourlySpend.find((h) => h.hour === hk);
    if (!hourEntry) { hourEntry = { hour: hk, costUsd: 0, requests: 0 }; this.hourlySpend.push(hourEntry); if (this.hourlySpend.length > 24) this.hourlySpend.shift(); }
    hourEntry.costUsd += cost; hourEntry.requests++;
  },

  getFullStats(mainConfig) {
    this.reset();
    const budget = mainConfig?.costTracking?.dailyBudgetUsd || 50;
    const totalRequests = Object.values(this.modelStats).reduce((s, m) => s + m.requests, 0);
    const totalInputTokens = Object.values(this.modelStats).reduce((s, m) => s + m.inputTokens, 0);
    const totalOutputTokens = Object.values(this.modelStats).reduce((s, m) => s + m.outputTokens, 0);
    return {
      summary: {
        dailySpendUsd: Math.round(this.dailySpendUsd * 10000) / 10000, dailyBudgetUsd: budget,
        percentUsed: Math.round((this.dailySpendUsd / budget) * 10000) / 100,
        totalRequests, totalInputTokens, totalOutputTokens,
        totalTokens: totalInputTokens + totalOutputTokens, date: this.lastResetDate,
        uptimeMs: Date.now() - this.startedAt,
      },
      modelBreakdown: Object.entries(this.modelStats).map(([model, s]) => ({
        model, requests: s.requests, inputTokens: s.inputTokens, outputTokens: s.outputTokens,
        totalTokens: s.inputTokens + s.outputTokens,
        costUsd: Math.round(s.costUsd * 10000) / 10000,
        percentOfSpend: this.dailySpendUsd > 0 ? Math.round((s.costUsd / this.dailySpendUsd) * 10000) / 100 : 0,
      })).sort((a, b) => b.costUsd - a.costUsd),
      routingStats: Object.entries(this.routingStats).map(([rule, hits]) => ({ rule, hits })).sort((a, b) => b.hits - a.hits),
      hourlySpend: this.hourlySpend.map((h) => ({ hour: h.hour, costUsd: Math.round(h.costUsd * 10000) / 10000, requests: h.requests })),
    };
  },
};

// ═══════════════════════════════════════════════════════════════════════
// SWARM ORCHESTRATOR
// ═══════════════════════════════════════════════════════════════════════

const swarmOrchestrator = {
  swarms: new Map(), nextId: 1, maxHistory: 50,

  _generateId() { return `swarm-${Date.now()}-${this.nextId++}`; },
  getTemplate(mc, id) { return mc?.swarms?.templates?.[id] || null; },
  getTemplates(mc) { return mc?.swarms?.templates || {}; },

  create(templateId, task, mainConfig) {
    const swarmConfig = mainConfig?.swarms || {};
    if (!swarmConfig.enabled) return { error: "Swarms are disabled" };

    const activeCount = [...this.swarms.values()].filter(s => s.status === "running").length;
    if (activeCount >= (swarmConfig.maxConcurrentSwarms || 3)) return { error: "Max concurrent swarms reached" };

    const template = this.getTemplate(mainConfig, templateId);
    if (!template) return { error: `Unknown template: ${templateId}` };

    const configuredAgents = mainConfig.agents || {};
    for (const step of template.steps) {
      if (!configuredAgents[step.agent]) return { error: `Agent "${step.agent}" not configured` };
    }

    const id = this._generateId();
    const swarm = {
      id, templateId, templateName: template.name, strategy: template.strategy, task,
      status: "running", createdAt: new Date().toISOString(), completedAt: null,
      steps: template.steps.map((step, i) => ({
        index: i, agent: step.agent,
        agentName: configuredAgents[step.agent]?.name || step.agent,
        model: configuredAgents[step.agent]?.model || "unknown",
        instruction: step.instruction, status: "pending",
        startedAt: null, completedAt: null, output: null, error: null, costUsd: 0,
      })),
      totalCostUsd: 0, result: null, error: null,
      timeoutAt: new Date(Date.now() + (swarmConfig.defaultTimeoutMinutes || 30) * 60_000).toISOString(),
    };

    this.swarms.set(id, swarm);
    this._pruneHistory();

    this._execute(id, mainConfig).catch(err => {
      const s = this.swarms.get(id);
      if (s && s.status === "running") {
        s.status = "failed"; s.error = err.message; s.completedAt = new Date().toISOString();
      }
    });

    return { ok: true, swarmId: id, swarm };
  },

  async _execute(swarmId, mainConfig) {
    const swarm = this.swarms.get(swarmId);
    if (!swarm) return;

    try {
      if (swarm.strategy === "parallel") {
        const ctx = `Task: ${swarm.task}`;
        const promises = swarm.steps.map(async (step) => {
          if (swarm.status !== "running") return;
          step.status = "running"; step.startedAt = new Date().toISOString();
          try {
            const result = await this._dispatchToAgent(step.agent, `${step.instruction}\n\nContext:\n${ctx}`, mainConfig);
            step.output = result.output; step.costUsd = result.costUsd || 0;
            swarm.totalCostUsd += step.costUsd; step.status = "completed"; step.completedAt = new Date().toISOString();
          } catch (err) {
            step.status = "failed"; step.error = err.message; step.completedAt = new Date().toISOString();
          }
        });
        await Promise.allSettled(promises);
        if (!swarm.steps.some(s => s.status === "completed")) throw new Error("All steps failed");
      } else {
        let previousOutput = `Task: ${swarm.task}`;
        for (const step of swarm.steps) {
          if (swarm.status !== "running") break;
          step.status = "running"; step.startedAt = new Date().toISOString();
          try {
            const result = await this._dispatchToAgent(step.agent, `${step.instruction}\n\nContext:\n${previousOutput}`, mainConfig);
            step.output = result.output; step.costUsd = result.costUsd || 0;
            swarm.totalCostUsd += step.costUsd; step.status = "completed"; step.completedAt = new Date().toISOString();
            previousOutput = result.output;
          } catch (err) {
            step.status = "failed"; step.error = err.message; step.completedAt = new Date().toISOString();
            throw err;
          }
        }
      }

      if (swarm.status === "running") {
        swarm.status = "completed"; swarm.completedAt = new Date().toISOString();
        swarm.result = swarm.steps.filter(s => s.status === "completed" && s.output)
          .map(s => `## ${s.agentName}\n${s.output}`).join("\n\n---\n\n");
      }
    } catch (err) {
      if (swarm.status === "running") {
        swarm.status = "failed"; swarm.error = err.message; swarm.completedAt = new Date().toISOString();
      }
      throw err;
    }
  },

  async _dispatchToAgent(agentId, prompt, mainConfig) {
    const agentConfig = mainConfig?.agents?.[agentId];
    const model = agentConfig?.model || mainConfig?.models?.primary?.model;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);

    try {
      const response = await fetch(`${gateway.target}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OPENCLAW_GATEWAY_TOKEN}` },
        body: JSON.stringify({
          model: model || "default",
          messages: [
            ...(agentConfig?.systemPrompt ? [{ role: "system", content: agentConfig.systemPrompt }] : []),
            { role: "user", content: prompt },
          ],
          max_tokens: 4096,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!response.ok) throw new Error(`Gateway ${response.status}: ${(await response.text()).slice(0, 200)}`);

      const data = await response.json();
      const output = data?.choices?.[0]?.message?.content || "(no response)";
      const usage = data?.usage || {};
      if (model && (usage.prompt_tokens || usage.completion_tokens)) {
        costTracker.record(model, usage.prompt_tokens || 0, usage.completion_tokens || 0, mainConfig);
      }
      const rates = mainConfig?.costTracking?.models?.[model];
      let costUsd = 0;
      if (rates) costUsd = ((usage.prompt_tokens || 0) / 1_000_000) * (rates.inputPer1M || 0) + ((usage.completion_tokens || 0) / 1_000_000) * (rates.outputPer1M || 0);
      return { output, costUsd };
    } catch (err) {
      clearTimeout(timeout);
      if (err.name === "AbortError") throw new Error(`Agent ${agentId} timed out`);
      throw err;
    }
  },

  cancel(id) {
    const s = this.swarms.get(id);
    if (!s) return { error: "Not found" };
    if (s.status !== "running") return { error: `Swarm is ${s.status}` };
    s.status = "cancelled"; s.completedAt = new Date().toISOString();
    for (const step of s.steps) {
      if (step.status === "pending" || step.status === "running") { step.status = "cancelled"; step.completedAt = new Date().toISOString(); }
    }
    return { ok: true };
  },

  getAll() { return [...this.swarms.values()].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)); },
  getActive() { return this.getAll().filter(s => s.status === "running"); },
  get(id) { return this.swarms.get(id) || null; },
  getStats() {
    const all = this.getAll();
    return {
      total: all.length,
      active: all.filter(s => s.status === "running").length,
      completed: all.filter(s => s.status === "completed").length,
      failed: all.filter(s => s.status === "failed").length,
      cancelled: all.filter(s => s.status === "cancelled").length,
      totalCostUsd: Math.round(all.reduce((s, x) => s + (x.totalCostUsd || 0), 0) * 10000) / 10000,
    };
  },
  _pruneHistory() {
    const terminal = this.getAll().filter(s => s.status !== "running");
    if (terminal.length > this.maxHistory) for (const s of terminal.slice(this.maxHistory)) this.swarms.delete(s.id);
  },
};

// ═══════════════════════════════════════════════════════════════════════
// SWARM + CONFIG + DASHBOARD API
// ═══════════════════════════════════════════════════════════════════════

app.get("/setup/api/swarms/templates", requireSetupAuth, (_req, res) => {
  const mc = loadMainConfig();
  const templates = Object.entries(swarmOrchestrator.getTemplates(mc)).map(([id, t]) => ({
    id, name: t.name, description: t.description, strategy: t.strategy, agents: t.agents, stepCount: t.steps?.length || 0,
  }));
  return res.json({ ok: true, templates });
});

app.get("/setup/api/swarms/stats", requireSetupAuth, (_req, res) => {
  return res.json({ ok: true, stats: swarmOrchestrator.getStats(), activeSwarms: swarmOrchestrator.getActive() });
});

app.get("/setup/api/swarms", requireSetupAuth, (_req, res) => {
  const swarms = swarmOrchestrator.getAll().map(s => ({
    id: s.id, templateId: s.templateId, templateName: s.templateName, strategy: s.strategy,
    task: s.task.length > 100 ? s.task.slice(0, 100) + "..." : s.task,
    status: s.status, createdAt: s.createdAt, completedAt: s.completedAt,
    totalCostUsd: Math.round((s.totalCostUsd || 0) * 10000) / 10000,
    stepsTotal: s.steps.length, stepsCompleted: s.steps.filter(st => st.status === "completed").length, error: s.error,
  }));
  return res.json({ ok: true, swarms, stats: swarmOrchestrator.getStats() });
});

app.get("/setup/api/swarms/:id", requireSetupAuth, (req, res) => {
  const swarm = swarmOrchestrator.get(req.params.id);
  if (!swarm) return res.status(404).json({ ok: false, error: "Not found" });
  return res.json({ ok: true, swarm });
});

app.post("/setup/api/swarms/spawn", requireSetupAuth, (req, res) => {
  const { templateId, task } = req.body || {};
  if (!templateId || !/^[A-Za-z0-9_-]+$/.test(templateId)) return res.status(400).json({ ok: false, error: "Invalid templateId" });
  if (!task || task.trim().length < 3 || task.length > 5000) return res.status(400).json({ ok: false, error: "task required (3-5000 chars)" });
  if (!gateway.isReady) return res.status(503).json({ ok: false, error: "Gateway not ready" });

  const mc = loadMainConfig();
  if (!mc) return res.status(500).json({ ok: false, error: "config/main.json not found" });

  const result = swarmOrchestrator.create(templateId, task.trim(), mc);
  if (result.error) return res.status(400).json({ ok: false, error: result.error });
  return res.json({ ok: true, swarmId: result.swarmId, templateName: result.swarm.templateName, strategy: result.swarm.strategy, steps: result.swarm.steps.length });
});

app.post("/setup/api/swarms/:id/cancel", requireSetupAuth, (req, res) => {
  const result = swarmOrchestrator.cancel(req.params.id);
  if (result.error) return res.status(400).json({ ok: false, error: result.error });
  return res.json({ ok: true });
});

// Config apply
app.post("/setup/api/config/apply", requireSetupAuth, async (req, res) => {
  if (!gateway.isConfigured) return res.status(400).json({ ok: false, error: "Not configured" });
  const mc = loadMainConfig();
  if (!mc) return res.status(404).json({ ok: false, error: "config/main.json not found" });

  let extra = "";
  const sections = [
    ["models.primary.model", mc.models?.primary?.model, (m) => clawCmd(["models", "set", m])],
  ];
  for (const [label, val, fn] of sections) {
    if (val) { const r = await fn(val); extra += `[${label}] exit=${r.code}\n`; }
  }

  for (const key of ["contextPruning", "caching", "heartbeat", "concurrency", "timeouts", "monitoring", "integrations"]) {
    if (mc[key]) { const r = await clawCmd(["config", "set", "--json", key, JSON.stringify(mc[key])]); extra += `[${key}] exit=${r.code}\n`; }
  }

  if (mc.agents) {
    for (const [id, cfg] of Object.entries(mc.agents)) {
      if (!/^[A-Za-z0-9_-]+$/.test(id)) continue;
      const r = await clawCmd(["config", "set", "--json", `agents.${id}`, JSON.stringify(cfg)]);
      extra += `[agents.${id}] exit=${r.code}\n`;
    }
  }

  try { await gateway.restart(); extra += "[gateway] restarted\n"; }
  catch (err) { extra += `[gateway] restart failed: ${err.message}\n`; }

  return res.json({ ok: true, output: redactSecrets(extra) });
});

app.get("/setup/api/costs", requireSetupAuth, (_req, res) => {
  const mc = loadMainConfig();
  const budget = mc?.costTracking?.dailyBudgetUsd || 50;
  costTracker.reset();
  return res.json({
    ok: true, dailySpendUsd: Math.round(costTracker.dailySpendUsd * 10000) / 10000,
    dailyBudgetUsd: budget, percentUsed: Math.round((costTracker.dailySpendUsd / budget) * 10000) / 100,
    date: costTracker.lastResetDate,
  });
});

// ═══ Dashboard stats — merges swarm + smart-router data ═══
app.get("/setup/api/dashboard/stats", requireSetupAuth, (_req, res) => {
  const mc = loadMainConfig();
  const fullStats = costTracker.getFullStats(mc);

  const configInfo = mc ? {
    primaryModel: mc.models?.primary?.model, fallbackModels: (mc.models?.fallback || []).map(f => f.model),
    routingEnabled: mc.models?.routing?.enabled || false,
    routingRules: (mc.models?.routing?.rules || []).map(r => ({ name: r.name, description: r.description, model: r.model })),
    agents: Object.entries(mc.agents || {}).map(([id, a]) => ({ id, name: a.name, role: a.role, model: a.model })),
    costRates: mc.costTracking?.models || {}, dailyBudgetUsd: mc.costTracking?.dailyBudgetUsd || 50,
    concurrency: mc.concurrency || {}, caching: mc.caching || {}, heartbeat: mc.heartbeat || {},
  } : null;

  // Smart Router data merge
  let smartRouterData = null;
  try {
    const sr = getSmartRouterInstance();
    const srSummary = sr.getDailySummary();
    const srModelStats = sr.getModelStats();
    const srEntries = sr.costTracker.getEntries();

    const srModelBreakdown = {};
    for (const e of srEntries) {
      const key = e.selected_model || "unknown";
      if (!srModelBreakdown[key]) srModelBreakdown[key] = { requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, type: e.model_type };
      srModelBreakdown[key].requests++; srModelBreakdown[key].inputTokens += e.input_tokens || 0;
      srModelBreakdown[key].outputTokens += e.output_tokens || 0; srModelBreakdown[key].costUsd += e.total_cost || 0;
    }

    smartRouterData = { summary: srSummary, modelHealth: srModelStats, status: sr.getStatus(), circuitBreakers: sr.getCircuitBreakers() };

    // Merge into fullStats
    for (const [model, s] of Object.entries(srModelBreakdown)) {
      const existing = fullStats.modelBreakdown.find(m => m.model === model);
      if (existing) { existing.requests += s.requests; existing.inputTokens += s.inputTokens; existing.outputTokens += s.outputTokens; existing.totalTokens += s.inputTokens + s.outputTokens; existing.costUsd += s.costUsd; }
      else fullStats.modelBreakdown.push({ model, requests: s.requests, inputTokens: s.inputTokens, outputTokens: s.outputTokens, totalTokens: s.inputTokens + s.outputTokens, costUsd: Math.round(s.costUsd * 10000) / 10000, modelType: s.type });
    }
    fullStats.modelBreakdown.sort((a, b) => b.requests - a.requests);
    fullStats.summary.totalRequests += srSummary.totalTasks || 0;
    fullStats.summary.dailySpendUsd += srSummary.totalCost || 0;
  } catch (err) {
    log.debug("smart-router stats unavailable", { error: err.message });
  }

  return res.json({
    ok: true, ...fullStats, config: configInfo,
    gateway: gateway.getStatus(), swarmStats: swarmOrchestrator.getStats(),
    activeSwarms: swarmOrchestrator.getActive(), smartRouter: smartRouterData,
    alerts: alerts.getHistory().slice(-20),
  });
});

app.get("/dashboard", requireSetupAuth, (_req, res) => {
  res.sendFile(path.join(process.cwd(), "src", "public", "dashboard.html"));
});

// ═══ Model management ═══
app.post("/setup/api/models/route", requireSetupAuth, (req, res) => {
  const mc = loadMainConfig();
  if (!mc) return res.status(404).json({ ok: false, error: "config not found" });
  const primary = mc.models?.primary?.model || "unknown";
  return res.json({ ok: true, selectedModel: primary, primary });
});

app.get("/setup/api/models", requireSetupAuth, async (_req, res) => {
  if (!gateway.isConfigured) return res.json({ ok: false, error: "Not configured" });
  const result = await clawCmd(["config", "get", "models"]);
  let models = null;
  try { models = JSON.parse(result.output.trim()); } catch {}
  return res.json({ ok: true, models, raw: result.output.trim() });
});

app.post("/setup/api/models", requireSetupAuth, async (req, res) => {
  if (!gateway.isConfigured) return res.status(400).json({ ok: false, error: "Not configured" });
  const { primaryModel, fallbackModel, customProviders } = req.body || {};
  let extra = "";

  if (primaryModel?.trim()) {
    const r = await clawCmd(["models", "set", primaryModel.trim()]);
    extra += `[models] primary=${primaryModel.trim()} exit=${r.code}\n`;
  }

  if (Array.isArray(customProviders)) {
    for (const p of customProviders) {
      if (!p.id?.trim() || !p.baseUrl?.trim()) continue;
      if (!/^[A-Za-z0-9_-]+$/.test(p.id.trim())) continue;
      try { new URL(p.baseUrl.trim()); } catch { continue; }
      const cfg = { id: p.id.trim(), baseUrl: p.baseUrl.trim() };
      if (p.apiKeyEnvVar?.trim()) cfg.apiKeyEnvVar = p.apiKeyEnvVar.trim();
      if (p.models?.trim()) cfg.models = p.models.trim().split(",").map(m => m.trim()).filter(Boolean);
      const r = await clawCmd(["config", "set", "--json", `providers.${p.id.trim()}`, JSON.stringify(cfg)]);
      extra += `[provider] ${p.id.trim()} exit=${r.code}\n`;
    }
  }

  if (extra) {
    try { await gateway.restart(); extra += "[gateway] restarted\n"; }
    catch (err) { extra += `[gateway] restart failed: ${err.message}\n`; }
  }
  return res.json({ ok: true, output: redactSecrets(extra) });
});

// ═══ Pairing + Devices + Reset + Doctor ═══
app.post("/setup/api/pairing/approve", requireSetupAuth, async (req, res) => {
  const { channel, code } = req.body || {};
  if (!channel || !code) return res.status(400).json({ ok: false, error: "Missing channel or code" });
  const ch = String(channel).toLowerCase().trim();
  if (!["telegram", "discord", "slack"].includes(ch)) return res.status(400).json({ ok: false, error: "Invalid channel" });
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(code).trim())) return res.status(400).json({ ok: false, error: "Invalid code" });
  const r = await clawCmd(["pairing", "approve", ch, String(code).trim()]);
  return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: r.output });
});

app.get("/setup/api/devices", requireSetupAuth, async (_req, res) => {
  const result = await clawCmd(["devices", "list", "--json", "--token", OPENCLAW_GATEWAY_TOKEN]);
  let data = null;
  try { data = JSON.parse(result.output); } catch {
    const s = result.output.indexOf("{"), e = result.output.lastIndexOf("}");
    if (s >= 0 && e > s) try { data = JSON.parse(result.output.slice(s, e + 1)); } catch {}
  }
  return res.json({ ok: result.code === 0 || Boolean(data), data, raw: result.output });
});

app.post("/setup/api/devices/approve", requireSetupAuth, async (req, res) => {
  const { requestId } = req.body || {};
  const args = ["devices", "approve"];
  if (requestId) {
    const t = String(requestId).trim();
    if (!/^[A-Za-z0-9-]+$/.test(t)) return res.status(400).json({ ok: false, error: "Invalid requestId" });
    args.push(t);
  } else { args.push("--latest"); }
  args.push("--token", OPENCLAW_GATEWAY_TOKEN);
  const result = await clawCmd(args);
  return res.status(result.code === 0 ? 200 : 500).json({ ok: result.code === 0, output: result.output });
});

app.post("/setup/api/reset", requireSetupAuth, (_req, res) => {
  try { fs.rmSync(gateway.configPath, { force: true }); res.type("text/plain").send("OK - config deleted."); }
  catch (err) { res.status(500).type("text/plain").send(String(err)); }
});

app.post("/setup/api/doctor", requireSetupAuth, async (_req, res) => {
  const result = await clawCmd(["doctor", "--non-interactive", "--repair"]);
  return res.status(result.code === 0 ? 200 : 500).json({ ok: result.code === 0, output: result.output });
});

// ═══ Export ═══
app.get("/setup/export", requireSetupAuth, async (_req, res) => {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
  res.setHeader("content-type", "application/gzip");
  res.setHeader("content-disposition", `attachment; filename="openclaw-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.tar.gz"`);

  const stateAbs = path.resolve(STATE_DIR);
  const workspaceAbs = path.resolve(WORKSPACE_DIR);
  const dataRoot = "/data";
  const underData = (p) => p === dataRoot || p.startsWith(dataRoot + path.sep);

  let cwd = "/", paths = [stateAbs, workspaceAbs].map((p) => p.replace(/^\//, ""));
  if (underData(stateAbs) && underData(workspaceAbs)) {
    cwd = dataRoot;
    paths = [path.relative(dataRoot, stateAbs) || ".", path.relative(dataRoot, workspaceAbs) || "."];
  }

  const { spawn } = await import("node:child_process");
  const tar = spawn("tar", ["-czf", "-", "--dereference", ...paths], { cwd, stdio: ["ignore", "pipe", "pipe"] });
  tar.stderr.on("data", (d) => log.warn("tar stderr", { msg: d.toString() }));
  tar.on("error", (err) => { log.error("tar error", err); if (!res.headersSent) res.status(500).end(); });
  tar.stdout.pipe(res);
});

// ═══ TUI ═══
app.get("/tui", requireSetupAuth, (_req, res) => {
  if (!ENABLE_WEB_TUI) return res.status(403).type("text/plain").send("Web TUI disabled. Set ENABLE_WEB_TUI=true");
  if (!gateway.isConfigured) return res.redirect("/setup");
  res.sendFile(path.join(process.cwd(), "src", "public", "tui.html"));
});

// ═══════════════════════════════════════════════════════════════════════
// CATCH-ALL PROXY
// ═══════════════════════════════════════════════════════════════════════

app.use(async (req, res) => {
  if (!gateway.isConfigured && !req.path.startsWith("/setup")) {
    if (!autoSetupRunning && !autoSetupDone) {
      runAutoSetup().catch((err) => log.error("auto-setup background error", err));
    }
    return res.status(503).sendFile(path.join(process.cwd(), "src", "public", "loading.html"));
  }

  if (gateway.isConfigured && !gateway.isReady) {
    try { await gateway.ensureRunning(); }
    catch { return res.status(503).sendFile(path.join(process.cwd(), "src", "public", "loading.html")); }
    if (!gateway.isReady) return res.status(503).sendFile(path.join(process.cwd(), "src", "public", "loading.html"));
  }

  return proxy.web(req, res, { target: gateway.target });
});

// ═══════════════════════════════════════════════════════════════════════
// SERVER STARTUP
// ═══════════════════════════════════════════════════════════════════════

const server = app.listen(PORT, () => {
  log.info("server started", { port: PORT, configured: gateway.isConfigured, tui: ENABLE_WEB_TUI });

  // Harden state dir
  try { fs.mkdirSync(path.join(STATE_DIR, "credentials"), { recursive: true, mode: 0o700 }); } catch {}
  try { fs.chmodSync(STATE_DIR, 0o700); } catch {}
  try { fs.chmodSync(path.join(STATE_DIR, "credentials"), 0o700); } catch {}

  if (gateway.isConfigured) {
    (async () => {
      try {
        const dr = await clawCmd(["doctor", "--fix"]);
        log.info("doctor --fix completed", { exit: dr.code });
      } catch {}
      await gateway.ensureRunning();
    })().catch((err) => log.error("gateway boot failed", err));
  } else {
    log.info("not configured — starting auto-setup");
    runAutoSetup().catch((err) => log.error("auto-setup boot failed", err));
  }
});

// ═══ TUI WebSocket ═══
let activeTuiSession = null;
const tuiWss = new WebSocketServer({ noServer: true });

tuiWss.on("connection", (ws, req) => {
  log.info("TUI session started", { ip: req.socket?.remoteAddress });
  let ptyProcess = null, idleTimer = null, maxTimer = null;
  activeTuiSession = { ws, pty: null, startedAt: Date.now(), lastActivity: Date.now() };

  function resetIdle() {
    if (activeTuiSession) activeTuiSession.lastActivity = Date.now();
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => ws.close(4002, "Idle timeout"), TUI_IDLE_TIMEOUT_MS);
  }

  function spawnPty(cols, rows) {
    if (ptyProcess) return;
    ptyProcess = pty.spawn(OPENCLAW_NODE, clawArgs(["tui"]), {
      name: "xterm-256color", cols, rows, cwd: WORKSPACE_DIR,
      env: { ...process.env, OPENCLAW_STATE_DIR: STATE_DIR, OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR, TERM: "xterm-256color" },
    });
    if (activeTuiSession) activeTuiSession.pty = ptyProcess;
    idleTimer = setTimeout(() => ws.close(4002, "Idle timeout"), TUI_IDLE_TIMEOUT_MS);
    maxTimer = setTimeout(() => ws.close(4002, "Max session"), TUI_MAX_SESSION_MS);
    ptyProcess.onData((data) => { if (ws.readyState === ws.OPEN) ws.send(data); });
    ptyProcess.onExit(({ exitCode }) => { if (ws.readyState === ws.OPEN) ws.close(1000, "Process exited"); });
  }

  ws.on("message", (message) => {
    resetIdle();
    try {
      const msg = JSON.parse(message.toString());
      if (msg.type === "resize" && msg.cols && msg.rows) {
        const cols = Math.min(Math.max(msg.cols, 10), 500), rows = Math.min(Math.max(msg.rows, 5), 200);
        if (!ptyProcess) spawnPty(cols, rows); else ptyProcess.resize(cols, rows);
      } else if (msg.type === "input" && msg.data && ptyProcess) { ptyProcess.write(msg.data); }
    } catch {}
  });

  ws.on("close", () => {
    clearTimeout(idleTimer); clearTimeout(maxTimer);
    if (ptyProcess) try { ptyProcess.kill(); } catch {}
    activeTuiSession = null;
  });
});

// ═══ WebSocket upgrade handler ═══
server.on("upgrade", async (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/tui/ws") {
    if (!ENABLE_WEB_TUI) { socket.write("HTTP/1.1 403 Forbidden\r\n\r\n"); socket.destroy(); return; }
    if (!verifyTuiAuth(req, SETUP_PASSWORD)) { socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); socket.destroy(); return; }
    if (activeTuiSession) { socket.write("HTTP/1.1 409 Conflict\r\n\r\n"); socket.destroy(); return; }
    tuiWss.handleUpgrade(req, socket, head, (ws) => tuiWss.emit("connection", ws, req));
    return;
  }

  if (!gateway.isConfigured) { socket.destroy(); return; }
  try { await gateway.ensureRunning(); }
  catch { socket.destroy(); return; }

  proxy.ws(req, socket, head, {
    target: gateway.target,
    headers: { Authorization: `Bearer ${OPENCLAW_GATEWAY_TOKEN}`, Origin: process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : gateway.target },
  });
});

// ═══ Graceful Shutdown ═══
async function gracefulShutdown(signal) {
  log.info("shutting down", { signal });

  if (activeTuiSession) {
    try { activeTuiSession.ws.close(1001, "Server shutting down"); if (activeTuiSession.pty) activeTuiSession.pty.kill(); } catch {}
    activeTuiSession = null;
  }

  server.close();
  await gateway.shutdown();
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
