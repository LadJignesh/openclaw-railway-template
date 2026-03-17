import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import express from "express";
import httpProxy from "http-proxy";
import pty from "node-pty";
import { WebSocketServer } from "ws";
import { registerSmartRouterRoutes, getSmartRouterInstance } from "./smart-router/routes.js";
import { buildAutoSetupPayload, detectProvider, detectNvidia } from "./auto-setup.js";

const PORT = Number.parseInt(process.env.PORT ?? "8080", 10);
const STATE_DIR =
  process.env.OPENCLAW_STATE_DIR?.trim() ||
  path.join(os.homedir(), ".openclaw");
const WORKSPACE_DIR =
  process.env.OPENCLAW_WORKSPACE_DIR?.trim() ||
  path.join(STATE_DIR, "workspace");

const SETUP_PASSWORD = process.env.SETUP_PASSWORD?.trim();

// Warn at startup if SETUP_PASSWORD is weak (but don't block — user may be in dev mode)
if (SETUP_PASSWORD && SETUP_PASSWORD.length < 12) {
  console.warn(
    "[security] SETUP_PASSWORD is shorter than 12 characters. " +
    "Use a stronger password for production deployments (e.g. Railway ${{ secret(32) }}).",
  );
}
if (!SETUP_PASSWORD) {
  console.warn(
    "[security] SETUP_PASSWORD is not set. The /setup wizard will be inaccessible.",
  );
}

// Debug logging helper
const DEBUG = process.env.OPENCLAW_TEMPLATE_DEBUG?.toLowerCase() === "true";
function debug(...args) {
  if (DEBUG) console.log(...args);
}

// Sync gateway.controlUi.allowedOrigins so the Control UI can load from the
// public Railway domain without "origin not allowed" errors.
async function syncAllowedOrigins() {
  const publicDomain = process.env.RAILWAY_PUBLIC_DOMAIN;
  if (!publicDomain) return;

  const origin = `https://${publicDomain}`;
  const result = await runCmd(
    OPENCLAW_NODE,
    clawArgs([
      "config",
      "set",
      "--json",
      "gateway.controlUi.allowedOrigins",
      JSON.stringify([origin]),
    ]),
  );
  if (result.code === 0) {
    console.log(`[gateway] set allowedOrigins to [${origin}]`);
  } else {
    console.warn(`[gateway] failed to set allowedOrigins (exit=${result.code})`);
  }
}

// Gateway admin token (protects Openclaw gateway + Control UI).
// Must be stable across restarts. If not provided via env, persist it in the state dir.
function resolveGatewayToken() {
  const envTok = process.env.OPENCLAW_GATEWAY_TOKEN?.trim();
  if (envTok) return envTok;

  const tokenPath = path.join(STATE_DIR, "gateway.token");
  try {
    const existing = fs.readFileSync(tokenPath, "utf8").trim();
    if (existing) return existing;
  } catch (err) {
    console.warn(
      `[gateway-token] could not read existing token: ${err.code || err.message}`,
    );
  }

  const generated = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(tokenPath, generated, { encoding: "utf8", mode: 0o600 });
  } catch (err) {
    console.warn(
      `[gateway-token] could not persist token: ${err.code || err.message}`,
    );
  }
  return generated;
}

const OPENCLAW_GATEWAY_TOKEN = resolveGatewayToken();
process.env.OPENCLAW_GATEWAY_TOKEN = OPENCLAW_GATEWAY_TOKEN;

let cachedOpenclawVersion = null;
let cachedChannelsHelp = null;

async function getOpenclawInfo() {
  if (!cachedOpenclawVersion) {
    const [version, channelsHelp] = await Promise.all([
      runCmd(OPENCLAW_NODE, clawArgs(["--version"])),
      runCmd(OPENCLAW_NODE, clawArgs(["channels", "add", "--help"])),
    ]);
    cachedOpenclawVersion = version.output.trim();
    cachedChannelsHelp = channelsHelp.output;
  }
  return { version: cachedOpenclawVersion, channelsHelp: cachedChannelsHelp };
}

const INTERNAL_GATEWAY_PORT = Number.parseInt(
  process.env.INTERNAL_GATEWAY_PORT ?? "18789",
  10,
);
const INTERNAL_GATEWAY_HOST = process.env.INTERNAL_GATEWAY_HOST ?? "127.0.0.1";
const GATEWAY_TARGET = `http://${INTERNAL_GATEWAY_HOST}:${INTERNAL_GATEWAY_PORT}`;

const OPENCLAW_ENTRY =
  process.env.OPENCLAW_ENTRY?.trim() || "/openclaw/dist/entry.js";
const OPENCLAW_NODE = process.env.OPENCLAW_NODE?.trim() || "node";

const ENABLE_WEB_TUI = process.env.ENABLE_WEB_TUI?.toLowerCase() === "true";
const TUI_IDLE_TIMEOUT_MS = Number.parseInt(
  process.env.TUI_IDLE_TIMEOUT_MS ?? "300000",
  10,
);
const TUI_MAX_SESSION_MS = Number.parseInt(
  process.env.TUI_MAX_SESSION_MS ?? "1800000",
  10,
);

function clawArgs(args) {
  return [OPENCLAW_ENTRY, ...args];
}

function configPath() {
  return (
    process.env.OPENCLAW_CONFIG_PATH?.trim() ||
    path.join(STATE_DIR, "openclaw.json")
  );
}

function isConfigured() {
  try {
    return fs.existsSync(configPath());
  } catch {
    return false;
  }
}

let gatewayProc = null;
let gatewayStarting = null;
let gatewayHealthy = false;  // Track if gateway responded to health check
let shuttingDown = false;    // Set true on SIGTERM/SIGINT to suppress auto-restart
let gatewayRestartCount = 0; // Track consecutive auto-restarts for backoff
const GATEWAY_MAX_RESTARTS = 10;
const GATEWAY_BACKOFF_BASE_MS = 2000;

// Debug breadcrumbs for common Railway failures (502 / "Application failed to respond").
let lastGatewayError = null;
let lastGatewayExit = null;
let lastDoctorOutput = null;
let lastDoctorAt = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForGatewayReady(opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const start = Date.now();
  const endpoints = ["/openclaw", "/openclaw", "/", "/health"];

  while (Date.now() - start < timeoutMs) {
    for (const endpoint of endpoints) {
      try {
        const res = await fetch(`${GATEWAY_TARGET}${endpoint}`, {
          method: "GET",
        });
        if (res) {
          console.log(`[gateway] ready at ${endpoint}`);
          gatewayRestartCount = 0; // Reset backoff on successful health check
          return true;
        }
      } catch (err) {
        if (err.code !== "ECONNREFUSED" && err.cause?.code !== "ECONNREFUSED") {
          const msg = err.code || err.message;
          if (msg !== "fetch failed" && msg !== "UND_ERR_CONNECT_TIMEOUT") {
            console.warn(`[gateway] health check error: ${msg}`);
          }
        }
      }
    }
    await sleep(250);
  }
  console.error(`[gateway] failed to become ready after ${timeoutMs / 1000} seconds`);
  return false;
}

async function startGateway() {
  if (gatewayProc) return;
  if (!isConfigured()) throw new Error("Gateway cannot start: not configured");

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

  // Clean up stale lock files before spawning to prevent startup failures
  for (const lockPath of [
    path.join(STATE_DIR, "gateway.lock"),
    "/tmp/openclaw-gateway.lock",
  ]) {
    try {
      fs.rmSync(lockPath, { force: true });
    } catch {}
  }

  // Sync wrapper token to openclaw.json before every gateway start.
  // This ensures the gateway's config-file token matches what the wrapper injects via proxy.
  console.log(`[gateway] ========== GATEWAY START TOKEN SYNC ==========`);
  console.log(`[gateway] Syncing wrapper token to config (length: ${OPENCLAW_GATEWAY_TOKEN.length})`);
  debug(`[gateway] Token preview: ${OPENCLAW_GATEWAY_TOKEN.slice(0, 16)}...`);

  const syncResult = await runCmd(
    OPENCLAW_NODE,
    clawArgs(["config", "set", "gateway.auth.token", OPENCLAW_GATEWAY_TOKEN]),
  );

  console.log(`[gateway] Sync result: exit code ${syncResult.code}`);
  if (syncResult.output?.trim()) {
    console.log(`[gateway] Sync output: ${syncResult.output}`);
  }

  const args = [
    "gateway",
    "run",
    "--bind",
    "loopback",
    "--port",
    String(INTERNAL_GATEWAY_PORT),
    "--auth",
    "token",
    "--token",
    OPENCLAW_GATEWAY_TOKEN,
    "--allow-unconfigured",
  ];

  gatewayProc = childProcess.spawn(OPENCLAW_NODE, clawArgs(args), {
    stdio: "inherit",
    env: {
      ...process.env,
      OPENCLAW_STATE_DIR: STATE_DIR,
      OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
    },
  });

  const safeArgs = args.map((arg, i) =>
    args[i - 1] === "--token" ? "[REDACTED]" : arg
  );
  console.log(
    `[gateway] starting with command: ${OPENCLAW_NODE} ${clawArgs(safeArgs).join(" ")}`,
  );
  console.log(`[gateway] STATE_DIR: ${STATE_DIR}`);
  console.log(`[gateway] WORKSPACE_DIR: ${WORKSPACE_DIR}`);
  console.log(`[gateway] config path: ${configPath()}`);

  gatewayProc.on("error", (err) => {
    console.error(`[gateway] spawn error: ${String(err)}`);
    lastGatewayError = String(err);
    gatewayProc = null;
  });

  gatewayProc.on("exit", (code, signal) => {
    console.error(`[gateway] exited code=${code} signal=${signal}`);
    lastGatewayExit = { code, signal, at: new Date().toISOString() };
    gatewayProc = null;
    gatewayHealthy = false;
    if (!shuttingDown && isConfigured()) {
      gatewayRestartCount++;
      if (gatewayRestartCount > GATEWAY_MAX_RESTARTS) {
        console.error(`[gateway] exceeded ${GATEWAY_MAX_RESTARTS} consecutive restarts — stopping auto-restart to prevent crash loop`);
        return;
      }
      const delayMs = Math.min(GATEWAY_BACKOFF_BASE_MS * Math.pow(2, gatewayRestartCount - 1), 60_000);
      console.log(`[gateway] scheduling auto-restart in ${delayMs / 1000}s (attempt ${gatewayRestartCount}/${GATEWAY_MAX_RESTARTS})...`);
      setTimeout(() => {
        if (!shuttingDown && !gatewayProc && isConfigured()) {
          ensureGatewayRunning().catch((err) => {
            console.error(`[gateway] auto-restart failed: ${err.message}`);
          });
        }
      }, delayMs);
    }
  });
}

async function ensureGatewayRunning() {
  if (!isConfigured()) return { ok: false, reason: "not configured" };
  if (gatewayProc) return { ok: true };
  if (!gatewayStarting) {
    gatewayStarting = (async () => {
      await syncAllowedOrigins();
      await startGateway();
      const ready = await waitForGatewayReady({ timeoutMs: 60_000 });
      if (!ready) {
        throw new Error("Gateway did not become ready in time");
      }
    })().finally(() => {
      gatewayStarting = null;
    });
  }
  await gatewayStarting;
  return { ok: true };
}

function isGatewayStarting() {
  return gatewayStarting !== null;
}

function isGatewayReady() {
  return gatewayProc !== null && gatewayStarting === null;
}

async function restartGateway() {
  if (gatewayProc) {
    try {
      gatewayProc.kill("SIGTERM");
    } catch (err) {
      console.warn(`[gateway] kill error: ${err.message}`);
    }
    await sleep(750);
    gatewayProc = null;
  }
  return ensureGatewayRunning();
}

// ========== PER-IP RATE LIMITER (sliding window, no external deps) ==========
const setupRateLimiter = {
  attempts: new Map(),
  windowMs: 60_000,
  maxAttempts: 50,
  cleanupInterval: setInterval(function () {
    const now = Date.now();
    for (const [ip, data] of setupRateLimiter.attempts) {
      if (now - data.windowStart > setupRateLimiter.windowMs) {
        setupRateLimiter.attempts.delete(ip);
      }
    }
  }, 60_000),

  isRateLimited(ip) {
    const now = Date.now();
    const data = this.attempts.get(ip);
    if (!data || now - data.windowStart > this.windowMs) {
      this.attempts.set(ip, { windowStart: now, count: 1 });
      return false;
    }
    data.count++;
    return data.count > this.maxAttempts;
  },
};

function requireSetupAuth(req, res, next) {
  if (!SETUP_PASSWORD) {
    return res
      .status(500)
      .type("text/plain")
      .send(
        "SETUP_PASSWORD is not set. Set it in Railway Variables before using /setup.",
      );
  }

  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  if (setupRateLimiter.isRateLimited(ip)) {
    return res.status(429).type("text/plain").send("Too many requests. Try again later.");
  }

  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) {
    res.set("WWW-Authenticate", 'Basic realm="OpenClaw Setup"');
    return res.status(401).send("Auth required");
  }
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  const password = idx >= 0 ? decoded.slice(idx + 1) : "";
  const passwordHash = crypto.createHash("sha256").update(password).digest();
  const expectedHash = crypto.createHash("sha256").update(SETUP_PASSWORD).digest();
  const isValid = crypto.timingSafeEqual(passwordHash, expectedHash);
  if (!isValid) {
    res.set("WWW-Authenticate", 'Basic realm="OpenClaw Setup"');
    return res.status(401).send("Invalid password");
  }
  return next();
}

async function probeGateway() {
  // Don't assume HTTP — the gateway primarily speaks WebSocket.
  // A simple TCP connect check is enough for "is it up".
  const net = await import("node:net");

  return await new Promise((resolve) => {
    const sock = net.createConnection({
      host: INTERNAL_GATEWAY_HOST,
      port: INTERNAL_GATEWAY_PORT,
      timeout: 750,
    });

    const done = (ok) => {
      try { sock.destroy(); } catch {}
      resolve(ok);
    };

    sock.on("connect", () => done(true));
    sock.on("timeout", () => done(false));
    sock.on("error", () => done(false));
  });
}

// Load loading.html once at startup for use in proxy error responses
let loadingHtmlContent = null;
try {
  loadingHtmlContent = fs.readFileSync(
    path.join(process.cwd(), "src", "public", "loading.html"),
    "utf8",
  );
} catch {
  // Fallback inline if file missing
  loadingHtmlContent = `<!DOCTYPE html><html><head><meta http-equiv="refresh" content="5"/><title>Starting</title></head><body><p>OpenClaw is starting. This page will refresh automatically.</p></body></html>`;
}

const app = express();
app.disable("x-powered-by");

// ========== SECURITY HEADERS ==========
app.use((_req, res, next) => {
  // Prevent clickjacking — only allow same-origin framing
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  // Prevent MIME-type sniffing
  res.setHeader("X-Content-Type-Options", "nosniff");
  // Enable XSS filter in older browsers
  res.setHeader("X-XSS-Protection", "1; mode=block");
  // Strict referrer policy — don't leak URLs to third parties
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  // Restrict browser features (camera, microphone, geolocation, etc.)
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=()",
  );
  // HSTS — enforce HTTPS (Railway terminates TLS at the edge)
  if (process.env.RAILWAY_PUBLIC_DOMAIN) {
    res.setHeader(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains",
    );
  }
  // Content Security Policy for setup pages (restrictive default)
  if (_req.path.startsWith("/setup") || _req.path === "/tui") {
    res.setHeader(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://unpkg.com",
        "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com",
        "img-src 'self' data: https://raw.githubusercontent.com",
        "connect-src 'self'",
        "frame-ancestors 'self'",
      ].join("; "),
    );
  }
  return next();
});

app.use(express.json({ limit: "1mb" }));

// Minimal health endpoint for Railway.
app.get("/setup/healthz", (_req, res) => res.json({ ok: true }));

// Smart Router API (inherits /setup auth from middleware above)
registerSmartRouterRoutes(app);

// ========== LIGHTWEIGHT RATE LIMITER FOR PUBLIC ENDPOINTS ==========
const publicRateLimiter = {
  hits: new Map(),
  windowMs: 10_000,
  maxHits: 30, // 30 req / 10s per IP
  cleanup: setInterval(function () {
    const now = Date.now();
    for (const [ip, data] of publicRateLimiter.hits) {
      if (now - data.windowStart > publicRateLimiter.windowMs) {
        publicRateLimiter.hits.delete(ip);
      }
    }
  }, 30_000),

  check(ip) {
    const now = Date.now();
    const data = this.hits.get(ip);
    if (!data || now - data.windowStart > this.windowMs) {
      this.hits.set(ip, { windowStart: now, count: 1 });
      return false;
    }
    data.count++;
    return data.count > this.maxHits;
  },
};

// Public health endpoint (no auth) so Railway can probe without /setup.
// Keep this free of secrets. Rate-limited to prevent abuse.
app.get("/healthz", async (req, res) => {
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  if (publicRateLimiter.check(ip)) {
    return res.status(429).type("text/plain").send("Too many requests");
  }
  let gateway = "unconfigured";
  if (isConfigured()) {
    gateway = isGatewayReady() ? "ready" : "starting";
  }
  res.json({ ok: true, gateway });
});

app.get("/setup/healthz", async (_req, res) => {
  const configured = isConfigured();
  const gatewayRunning = isGatewayReady();
  const starting = isGatewayStarting();
  let gatewayReachable = false;

  if (gatewayRunning) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const r = await fetch(`${GATEWAY_TARGET}/`, { signal: controller.signal });
      clearTimeout(timeout);
      gatewayReachable = r !== null;
    } catch {}
  }

  res.json({
    ok: true,
    wrapper: true,
    configured,
    gatewayRunning,
    gatewayStarting: starting,
    gatewayReachable,
  });
});

// Logout: forces browser to clear cached Basic Auth credentials
app.get("/setup/logout", (_req, res) => {
  res.set("WWW-Authenticate", 'Basic realm="OpenClaw Setup"');
  res.set("Clear-Site-Data", '"cookies"');
  return res
    .status(401)
    .type("text/html")
    .send(
      '<!doctype html><html><head><meta charset="utf-8"><title>Signed Out</title></head>' +
      '<body style="font-family:system-ui;text-align:center;padding:80px 20px;background:#0a0a0a;color:#e5e5e5">' +
      '<h2>Signed out of OpenClaw Setup</h2>' +
      '<p style="color:#737373;margin:12px 0 24px">Your browser credentials have been cleared.</p>' +
      '<a href="/setup" style="color:#a855f7;text-decoration:underline">Sign in again</a>' +
      '</body></html>',
    );
});

app.get("/setup", requireSetupAuth, (_req, res) => {
  // Wizard removed — serve admin dashboard instead (debug console, config editor, backup)
  res.sendFile(path.join(process.cwd(), "src", "public", "dashboard.html"));
});

app.get("/setup/api/status", requireSetupAuth, async (_req, res) => {
  const { version, channelsHelp } = await getOpenclawInfo();

  const authGroups = [
    {
      value: "openai",
      label: "OpenAI",
      hint: "Codex OAuth + API key",
      options: [
        { value: "codex-cli", label: "OpenAI Codex OAuth (Codex CLI)" },
        { value: "openai-codex", label: "OpenAI Codex (ChatGPT OAuth)" },
        { value: "openai-api-key", label: "OpenAI API key" },
      ],
    },
    {
      value: "anthropic",
      label: "Anthropic",
      hint: "Claude Code CLI + API key",
      options: [
        { value: "claude-cli", label: "Anthropic token (Claude Code CLI)" },
        { value: "token", label: "Anthropic token (paste setup-token)" },
        { value: "apiKey", label: "Anthropic API key" },
      ],
    },
    {
      value: "google",
      label: "Google",
      hint: "Gemini API key + OAuth",
      options: [
        { value: "gemini-api-key", label: "Google Gemini API key" },
        { value: "google-antigravity", label: "Google Antigravity OAuth" },
        { value: "google-gemini-cli", label: "Google Gemini CLI OAuth" },
      ],
    },
    {
      value: "openrouter",
      label: "OpenRouter",
      hint: "API key",
      options: [{ value: "openrouter-api-key", label: "OpenRouter API key" }],
    },
    {
      value: "ai-gateway",
      label: "Vercel AI Gateway",
      hint: "API key",
      options: [
        { value: "ai-gateway-api-key", label: "Vercel AI Gateway API key" },
      ],
    },
    {
      value: "moonshot",
      label: "Moonshot AI",
      hint: "Kimi K2 + Kimi Code",
      options: [
        { value: "moonshot-api-key", label: "Moonshot AI API key" },
        { value: "kimi-code-api-key", label: "Kimi Code API key" },
      ],
    },
    {
      value: "zai",
      label: "Z.AI (GLM 4.7)",
      hint: "API key",
      options: [{ value: "zai-api-key", label: "Z.AI (GLM 4.7) API key" }],
    },
    {
      value: "minimax",
      label: "MiniMax",
      hint: "M2.1 (recommended)",
      options: [
        { value: "minimax-api", label: "MiniMax M2.1" },
        { value: "minimax-api-lightning", label: "MiniMax M2.1 Lightning" },
      ],
    },
    {
      value: "qwen",
      label: "Qwen",
      hint: "OAuth",
      options: [{ value: "qwen-portal", label: "Qwen OAuth" }],
    },
    {
      value: "copilot",
      label: "Copilot",
      hint: "GitHub + local proxy",
      options: [
        {
          value: "github-copilot",
          label: "GitHub Copilot (GitHub device login)",
        },
        { value: "copilot-proxy", label: "Copilot Proxy (local)" },
      ],
    },
    {
      value: "synthetic",
      label: "Synthetic",
      hint: "Anthropic-compatible (multi-model)",
      options: [{ value: "synthetic-api-key", label: "Synthetic API key" }],
    },
    {
      value: "opencode-zen",
      label: "OpenCode Zen",
      hint: "API key",
      options: [
        { value: "opencode-zen", label: "OpenCode Zen (multi-model proxy)" },
      ],
    },
  ];

  // Build available models per provider group based on env vars + known defaults
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
      { value: "anthropic/claude-3-5-sonnet-20241022", label: "Claude 3.5 Sonnet (via OpenRouter)", tier: "mid" },
      { value: "openai/gpt-4o", label: "GPT-4o (via OpenRouter)", tier: "mid" },
      { value: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro (via OpenRouter)", tier: "mid" },
      { value: "openai/gpt-4o-mini", label: "GPT-4o Mini (via OpenRouter)", tier: "low" },
    ],
    moonshot: [
      { value: "moonshot/kimi-k2", label: "Kimi K2", tier: "mid" },
    ],
    minimax: [
      { value: "minimax/m2.1", label: "MiniMax M2.1", tier: "mid" },
      { value: "minimax/m2.1-lightning", label: "MiniMax M2.1 Lightning", tier: "low" },
    ],
    qwen: [
      { value: "qwen/qwen3-235b-a22b", label: "Qwen3 235B", tier: "mid" },
    ],
    copilot: [
      { value: "copilot/gpt-4o", label: "GPT-4o (via Copilot)", tier: "mid" },
    ],
  };

  // Detect available API keys from environment
  const detectedProviders = [];
  if (process.env.ANTHROPIC_API_KEY) detectedProviders.push("anthropic");
  if (process.env.OPENAI_API_KEY) detectedProviders.push("openai");
  if (process.env.OPENROUTER_API_KEY) detectedProviders.push("openrouter");
  if (process.env.GOOGLE_CREDENTIALS_JSON || process.env.GEMINI_API_KEY) detectedProviders.push("google");
  if (process.env.MOONSHOT_API_KEY) detectedProviders.push("moonshot");
  if (process.env.MINIMAX_API_KEY) detectedProviders.push("minimax");

  res.json({
    configured: isConfigured(),
    gatewayTarget: GATEWAY_TARGET,
    openclawVersion: version,
    channelsAddHelp: channelsHelp,
    authGroups,
    tuiEnabled: ENABLE_WEB_TUI,
    providerModels,
    detectedProviders,
  });
});

function buildOnboardArgs(payload) {
  const args = [
    "onboard",
    "--non-interactive",
    "--accept-risk",
    "--json",
    "--no-install-daemon",
    "--skip-health",
    "--workspace",
    WORKSPACE_DIR,
    "--gateway-bind",
    "loopback",
    "--gateway-port",
    String(INTERNAL_GATEWAY_PORT),
    "--gateway-auth",
    "token",
    "--gateway-token",
    OPENCLAW_GATEWAY_TOKEN,
    "--flow",
    payload.flow || "quickstart",
  ];

  if (payload.authChoice) {
    args.push("--auth-choice", payload.authChoice);

    const secret = (payload.authSecret || "").trim();
    const map = {
      "openai-api-key": "--openai-api-key",
      apiKey: "--anthropic-api-key",
      "openrouter-api-key": "--openrouter-api-key",
      "ai-gateway-api-key": "--ai-gateway-api-key",
      "moonshot-api-key": "--moonshot-api-key",
      "kimi-code-api-key": "--kimi-code-api-key",
      "gemini-api-key": "--gemini-api-key",
      "zai-api-key": "--zai-api-key",
      "minimax-api": "--minimax-api-key",
      "minimax-api-lightning": "--minimax-api-key",
      "synthetic-api-key": "--synthetic-api-key",
      "opencode-zen": "--opencode-zen-api-key",
    };
    const flag = map[payload.authChoice];
    if (flag && secret) {
      args.push(flag, secret);
    }

    if (payload.authChoice === "token" && secret) {
      args.push("--token-provider", "anthropic", "--token", secret);
    }
  }

  return args;
}

// ========== AUTO-SETUP (headless onboarding from env vars) ==========

let autoSetupRunning = false;
let autoSetupDone = false;

async function runAutoSetup() {
  if (autoSetupRunning || autoSetupDone || isConfigured()) return;

  const payload = buildAutoSetupPayload();
  if (!payload) {
    console.error(
      "[auto-setup] No API key detected in environment. Set one of: " +
      "ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY, GEMINI_API_KEY, " +
      "MOONSHOT_API_KEY, or MINIMAX_API_KEY",
    );
    return;
  }

  autoSetupRunning = true;
  console.log(`[auto-setup] Detected provider: ${payload._provider.label} (${payload._provider.envVar})`);

  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

    // Run onboarding
    const onboardArgs = buildOnboardArgs(payload);
    console.log("[auto-setup] Running onboarding...");
    const onboard = await runCmd(OPENCLAW_NODE, clawArgs(onboardArgs));
    console.log(`[auto-setup] Onboarding exit=${onboard.code} configured=${isConfigured()}`);

    if (onboard.code !== 0 || !isConfigured()) {
      console.error(`[auto-setup] Onboarding failed:\n${onboard.output}`);
      return;
    }

    // Configure gateway settings (same as /setup/api/run)
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.controlUi.allowInsecureAuth", "true"]));
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.auth.token", OPENCLAW_GATEWAY_TOKEN]));
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "--json", "gateway.trustedProxies", '["127.0.0.1"]']));
    console.log("[auto-setup] Gateway settings configured.");

    // Set model if specified
    if (payload.model) {
      const mr = await runCmd(OPENCLAW_NODE, clawArgs(["models", "set", payload.model]));
      console.log(`[auto-setup] Model set to ${payload.model} (exit=${mr.code})`);
    }

    // Configure channels from env vars
    async function autoConfigChannel(name, cfgObj) {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "--json", `channels.${name}`, JSON.stringify(cfgObj)]));
      console.log(`[auto-setup] Channel ${name} configured (exit=${r.code})`);
    }

    if (payload.telegramToken) {
      await autoConfigChannel("telegram", {
        enabled: true,
        dmPolicy: "pairing",
        botToken: payload.telegramToken,
        groupPolicy: "allowlist",
        streamMode: "partial",
      });
    }

    if (payload.discordToken) {
      await autoConfigChannel("discord", {
        enabled: true,
        token: payload.discordToken,
        groupPolicy: "allowlist",
        dm: { policy: "pairing" },
      });
    }

    if (payload.slackBotToken || payload.slackAppToken) {
      await autoConfigChannel("slack", {
        enabled: true,
        botToken: payload.slackBotToken || undefined,
        appToken: payload.slackAppToken || undefined,
      });
    }

    // Configure NVIDIA as a custom provider if NVIDIA_API_KEY is set
    const nvidia = detectNvidia();
    if (nvidia) {
      console.log(`[auto-setup] Configuring NVIDIA provider (${nvidia.models.length} models)...`);
      const nvidiaConfig = {
        id: "nvidia",
        baseUrl: "https://integrate.api.nvidia.com/v1",
        apiKeyEnvVar: "NVIDIA_API_KEY",
        models: nvidia.models,
      };
      const nr = await runCmd(
        OPENCLAW_NODE,
        clawArgs(["config", "set", "--json", "providers.nvidia", JSON.stringify(nvidiaConfig)]),
      );
      console.log(`[auto-setup] NVIDIA provider configured (exit=${nr.code})`);

      // NVIDIA is available as a provider but minimax/m2.1-lightning stays the default model
    }

    // Start gateway
    console.log("[auto-setup] Starting gateway...");
    await restartGateway();
    console.log("[auto-setup] Setup complete — gateway running.");
    autoSetupDone = true;
  } catch (err) {
    console.error(`[auto-setup] Error: ${err.message}`);
  } finally {
    autoSetupRunning = false;
  }
}

function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const proc = childProcess.spawn(cmd, args, {
      ...opts,
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: STATE_DIR,
        OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
      },
    });

    let out = "";
    proc.stdout?.on("data", (d) => (out += d.toString("utf8")));
    proc.stderr?.on("data", (d) => (out += d.toString("utf8")));

    proc.on("error", (err) => {
      out += `\n[spawn error] ${String(err)}\n`;
      resolve({ code: 127, output: out });
    });

    proc.on("close", (code) => resolve({ code: code ?? 0, output: out }));
  });
}

const VALID_FLOWS = ["quickstart", "advanced", "manual"];
const VALID_AUTH_CHOICES = [
  "codex-cli",
  "openai-codex",
  "openai-api-key",
  "claude-cli",
  "token",
  "apiKey",
  "gemini-api-key",
  "google-antigravity",
  "google-gemini-cli",
  "openrouter-api-key",
  "ai-gateway-api-key",
  "moonshot-api-key",
  "kimi-code-api-key",
  "zai-api-key",
  "minimax-api",
  "minimax-api-lightning",
  "qwen-portal",
  "github-copilot",
  "copilot-proxy",
  "synthetic-api-key",
  "opencode-zen",
];

function validatePayload(payload) {
  if (payload.flow && !VALID_FLOWS.includes(payload.flow)) {
    return `Invalid flow: ${payload.flow}. Must be one of: ${VALID_FLOWS.join(", ")}`;
  }
  if (payload.authChoice && !VALID_AUTH_CHOICES.includes(payload.authChoice)) {
    return `Invalid authChoice: ${payload.authChoice}`;
  }
  const stringFields = [
    "telegramToken",
    "discordToken",
    "slackBotToken",
    "slackAppToken",
    "authSecret",
    "model",
  ];
  for (const field of stringFields) {
    if (payload[field] !== undefined && typeof payload[field] !== "string") {
      return `Invalid ${field}: must be a string`;
    }
  }
  return null;
}

app.post("/setup/api/run", requireSetupAuth, async (req, res) => {
  try {
    if (isConfigured()) {
      await ensureGatewayRunning();
      return res.json({
        ok: true,
        output:
          "Already configured.\nUse Reset setup if you want to rerun onboarding.\n",
      });
    }

    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

    const payload = req.body || {};
    const validationError = validatePayload(payload);
    if (validationError) {
      return res.status(400).json({ ok: false, output: validationError });
    }
    const onboardArgs = buildOnboardArgs(payload);
    const onboard = await runCmd(OPENCLAW_NODE, clawArgs(onboardArgs));

    let extra = "";
    extra += `\n[setup] Onboarding exit=${onboard.code} configured=${isConfigured()}\n`;

    const ok = onboard.code === 0 && isConfigured();

    if (ok) {
      extra += "\n[setup] Configuring gateway settings...\n";

      const allowInsecureResult = await runCmd(
        OPENCLAW_NODE,
        clawArgs([
          "config",
          "set",
          "gateway.controlUi.allowInsecureAuth",
          "true",
        ]),
      );
      extra += `[config] gateway.controlUi.allowInsecureAuth=true exit=${allowInsecureResult.code}\n`;

      const tokenResult = await runCmd(
        OPENCLAW_NODE,
        clawArgs([
          "config",
          "set",
          "gateway.auth.token",
          OPENCLAW_GATEWAY_TOKEN,
        ]),
      );
      extra += `[config] gateway.auth.token exit=${tokenResult.code}\n`;

      const proxiesResult = await runCmd(
        OPENCLAW_NODE,
        clawArgs([
          "config",
          "set",
          "--json",
          "gateway.trustedProxies",
          '["127.0.0.1"]',
        ]),
      );
      extra += `[config] gateway.trustedProxies exit=${proxiesResult.code}\n`;

      if (payload.model?.trim()) {
        extra += `[setup] Setting model to ${payload.model.trim()}...\n`;
        const modelResult = await runCmd(
          OPENCLAW_NODE,
          clawArgs(["models", "set", payload.model.trim()]),
        );
        extra += `[models set] exit=${modelResult.code}\n${modelResult.output || ""}`;
      }

      async function configureChannel(name, cfgObj) {
        const set = await runCmd(
          OPENCLAW_NODE,
          clawArgs([
            "config",
            "set",
            "--json",
            `channels.${name}`,
            JSON.stringify(cfgObj),
          ]),
        );
        const get = await runCmd(
          OPENCLAW_NODE,
          clawArgs(["config", "get", `channels.${name}`]),
        );
        return (
          `\n[${name} config] exit=${set.code} (output ${set.output.length} chars)\n${set.output || "(no output)"}` +
          `\n[${name} verify] exit=${get.code} (output ${get.output.length} chars)\n${get.output || "(no output)"}`
        );
      }

      if (payload.telegramToken?.trim()) {
        extra += await configureChannel("telegram", {
          enabled: true,
          dmPolicy: "pairing",
          botToken: payload.telegramToken.trim(),
          groupPolicy: "allowlist",
          streamMode: "partial",
        });
      }

      if (payload.discordToken?.trim()) {
        extra += await configureChannel("discord", {
          enabled: true,
          token: payload.discordToken.trim(),
          groupPolicy: "allowlist",
          dm: { policy: "pairing" },
        });
      }

      if (payload.slackBotToken?.trim() || payload.slackAppToken?.trim()) {
        extra += await configureChannel("slack", {
          enabled: true,
          botToken: payload.slackBotToken?.trim() || undefined,
          appToken: payload.slackAppToken?.trim() || undefined,
        });
      }

      extra += "\n[setup] Starting gateway...\n";
      await restartGateway();
      extra += "[setup] Gateway started.\n";
    }

    return res.status(ok ? 200 : 500).json({
      ok,
      output: `${onboard.output}${extra}`,
    });
  } catch (err) {
    console.error("[/setup/api/run] error:", err);
    return res
      .status(500)
      .json({ ok: false, output: `Internal error: ${String(err)}` });
  }
});

function redactSecrets(text) {
  if (!text) return text;
  // Best-effort redaction for common API key and token patterns.
  return String(text)
    // OpenAI API keys (sk-proj-..., sk-...)
    .replace(/(sk-(?:proj-)?[A-Za-z0-9_-]{10,})/g, "[REDACTED]")
    // GitHub tokens (gho_, ghp_, ghs_, ghr_)
    .replace(/(gh[opsr]_[A-Za-z0-9_]{10,})/g, "[REDACTED]")
    // Slack tokens
    .replace(/(xox[baprs]-[A-Za-z0-9-]{10,})/g, "[REDACTED]")
    // Telegram bot tokens (123456:ABCDEF...)
    .replace(/(\d{5,}:[A-Za-z0-9_-]{10,})/g, "[REDACTED]")
    // Anthropic setup tokens (AA...:...)
    .replace(/(AA[A-Za-z0-9_-]{10,}:\S{10,})/g, "[REDACTED]")
    // Anthropic API keys (sk-ant-...)
    .replace(/(sk-ant-[A-Za-z0-9_-]{10,})/g, "[REDACTED]")
    // Google API keys (AIza...)
    .replace(/(AIza[A-Za-z0-9_-]{30,})/g, "[REDACTED]")
    // OpenRouter API keys (sk-or-...)
    .replace(/(sk-or-[A-Za-z0-9_-]{10,})/g, "[REDACTED]")
    // Discord bot tokens (base64-ish, long strings after "Bot ")
    .replace(/((?:Bot\s+)?[A-Za-z0-9]{24,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,})/g, "[REDACTED]")
    // Generic bearer tokens in output (Bearer <token>)
    .replace(/(Bearer\s+)[A-Za-z0-9_.-]{20,}/gi, "$1[REDACTED]")
    // Gateway token (if it appears in output)
    .replace(new RegExp(escapeRegExp(OPENCLAW_GATEWAY_TOKEN), "g"), "[REDACTED]");
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ========== WEB TUI: AUTH + SESSION MANAGEMENT ==========

function verifyTuiAuth(req) {
  if (!SETUP_PASSWORD) return false;
  // Check Authorization header (Basic auth)
  const authHeader = req.headers["authorization"] || "";
  if (authHeader.startsWith("Basic ")) {
    const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf8");
    const password = decoded.includes(":") ? decoded.split(":").slice(1).join(":") : decoded;
    const passwordHash = crypto.createHash("sha256").update(password).digest();
    const expectedHash = crypto.createHash("sha256").update(SETUP_PASSWORD).digest();
    if (crypto.timingSafeEqual(passwordHash, expectedHash)) return true;
  }
  // Check WebSocket subprotocol for browser clients (browsers can't set custom headers)
  const protocols = (req.headers["sec-websocket-protocol"] || "").split(",").map(s => s.trim());
  for (const proto of protocols) {
    if (proto.startsWith("auth-")) {
      try {
        const decoded = Buffer.from(proto.slice(5), "base64").toString("utf8");
        const password = decoded.includes(":") ? decoded.split(":").slice(1).join(":") : decoded;
        const passwordHash = crypto.createHash("sha256").update(password).digest();
        const expectedHash = crypto.createHash("sha256").update(SETUP_PASSWORD).digest();
        if (crypto.timingSafeEqual(passwordHash, expectedHash)) return true;
      } catch { /* invalid base64 */ }
    }
  }
  return false;
}

let activeTuiSession = null;

function createTuiWebSocketServer(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws, req) => {
    const clientIp = req.socket?.remoteAddress || "unknown";
    console.log(`[tui] session started from ${clientIp}`);

    let ptyProcess = null;
    let idleTimer = null;
    let maxSessionTimer = null;

    activeTuiSession = {
      ws,
      pty: null,
      startedAt: Date.now(),
      lastActivity: Date.now(),
    };

    function resetIdleTimer() {
      if (activeTuiSession) {
        activeTuiSession.lastActivity = Date.now();
      }
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        console.log("[tui] session idle timeout");
        ws.close(4002, "Idle timeout");
      }, TUI_IDLE_TIMEOUT_MS);
    }

    function spawnPty(cols, rows) {
      if (ptyProcess) return;

      console.log(`[tui] spawning PTY with ${cols}x${rows}`);
      ptyProcess = pty.spawn(OPENCLAW_NODE, clawArgs(["tui"]), {
        name: "xterm-256color",
        cols,
        rows,
        cwd: WORKSPACE_DIR,
        env: {
          ...process.env,
          OPENCLAW_STATE_DIR: STATE_DIR,
          OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
          TERM: "xterm-256color",
        },
      });

      if (activeTuiSession) {
        activeTuiSession.pty = ptyProcess;
      }

      idleTimer = setTimeout(() => {
        console.log("[tui] session idle timeout");
        ws.close(4002, "Idle timeout");
      }, TUI_IDLE_TIMEOUT_MS);

      maxSessionTimer = setTimeout(() => {
        console.log("[tui] max session duration reached");
        ws.close(4002, "Max session duration");
      }, TUI_MAX_SESSION_MS);

      ptyProcess.onData((data) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(data);
        }
      });

      ptyProcess.onExit(({ exitCode, signal }) => {
        console.log(`[tui] PTY exited code=${exitCode} signal=${signal}`);
        if (ws.readyState === ws.OPEN) {
          ws.close(1000, "Process exited");
        }
      });
    }

    ws.on("message", (message) => {
      resetIdleTimer();
      try {
        const msg = JSON.parse(message.toString());
        if (msg.type === "resize" && msg.cols && msg.rows) {
          const cols = Math.min(Math.max(msg.cols, 10), 500);
          const rows = Math.min(Math.max(msg.rows, 5), 200);
          if (!ptyProcess) {
            spawnPty(cols, rows);
          } else {
            ptyProcess.resize(cols, rows);
          }
        } else if (msg.type === "input" && msg.data && ptyProcess) {
          ptyProcess.write(msg.data);
        }
      } catch (err) {
        console.warn(`[tui] invalid message: ${err.message}`);
      }
    });

    ws.on("close", () => {
      console.log("[tui] session closed");
      clearTimeout(idleTimer);
      clearTimeout(maxSessionTimer);
      if (ptyProcess) {
        try {
          ptyProcess.kill();
        } catch {}
      }
      activeTuiSession = null;
    });

    ws.on("error", (err) => {
      console.error(`[tui] WebSocket error: ${err.message}`);
    });
  });

  return wss;
}

// ========== DEBUG CONSOLE: HELPER FUNCTIONS & ALLOWLIST ==========

// Extract device requestIds from device list output for validation
function extractDeviceRequestIds(output) {
  const ids = [];
  const lines = (output || "").split("\n");
  // Look for lines with requestId format: alphanumeric, underscore, dash
  for (const line of lines) {
    const match = line.match(/requestId[:\s]+([A-Za-z0-9_-]+)/i);
    if (match) ids.push(match[1]);
  }
  return ids;
}

// Allowlisted commands for debug console (security-critical: no arbitrary shell execution)
const ALLOWED_CONSOLE_COMMANDS = new Set([
  // Gateway lifecycle (wrapper-managed, no openclaw CLI needed)
  "gateway.restart",
  "gateway.stop",
  "gateway.start",

  // OpenClaw CLI commands (all safe, read-only or user-controlled)
  "openclaw.version",
  "openclaw.status",
  "openclaw.health",
  "openclaw.doctor",
  "openclaw.logs.tail",
  "openclaw.config.get",
  "openclaw.devices.list",
  "openclaw.devices.approve",
  "openclaw.plugins.list",
  "openclaw.plugins.enable",
]);

// Debug console command handler (POST /setup/api/console/run)
app.post("/setup/api/console/run", requireSetupAuth, async (req, res) => {
  try {
    const { command, arg } = req.body || {};

    // Validate command is allowlisted
    if (!command || !ALLOWED_CONSOLE_COMMANDS.has(command)) {
      return res.status(400).json({
        ok: false,
        error: `Command not allowed: ${command || "(empty)"}`,
      });
    }

    let result;

    // Gateway lifecycle commands (wrapper-managed, no openclaw CLI)
    if (command === "gateway.restart") {
      await restartGateway();
      result = { code: 0, output: "Gateway restarted successfully\n" };
    } else if (command === "gateway.stop") {
      if (gatewayProc) {
        gatewayProc.kill("SIGTERM");
        gatewayProc = null;
        result = { code: 0, output: "Gateway stopped\n" };
      } else {
        result = { code: 0, output: "Gateway not running\n" };
      }
    } else if (command === "gateway.start") {
      await ensureGatewayRunning();
      result = { code: 0, output: "Gateway started successfully\n" };
    }

    // OpenClaw CLI commands
    else if (command === "openclaw.version") {
      result = await runCmd(OPENCLAW_NODE, clawArgs(["--version"]));
    } else if (command === "openclaw.status") {
      result = await runCmd(OPENCLAW_NODE, clawArgs(["status"]));
    } else if (command === "openclaw.health") {
      result = await runCmd(OPENCLAW_NODE, clawArgs(["health"]));
    } else if (command === "openclaw.doctor") {
      result = await runCmd(OPENCLAW_NODE, clawArgs(["doctor"]));
    } else if (command === "openclaw.logs.tail") {
      // arg is the tail count (default 50)
      const count = arg?.trim() || "50";
      if (!/^\d+$/.test(count)) {
        return res.status(400).json({
          ok: false,
          error: "Invalid tail count (must be a number)",
        });
      }
      result = await runCmd(OPENCLAW_NODE, clawArgs(["logs", "--tail", count]));
    } else if (command === "openclaw.config.get") {
      // arg is the config path (e.g., "gateway.port")
      const cfgPath = arg?.trim();
      if (!cfgPath) {
        return res.status(400).json({
          ok: false,
          error: "Config path required (e.g., gateway.port)",
        });
      }
      result = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", cfgPath]));
    } else if (command === "openclaw.devices.list") {
      result = await runCmd(OPENCLAW_NODE, clawArgs(["devices", "list"]));
    } else if (command === "openclaw.devices.approve") {
      // arg is the device requestId
      const requestId = arg?.trim();
      if (!requestId) {
        return res.status(400).json({
          ok: false,
          error: "Device requestId required",
        });
      }
      // Validate requestId format (alphanumeric, underscore, dash)
      if (!/^[A-Za-z0-9_-]+$/.test(requestId)) {
        return res.status(400).json({
          ok: false,
          error: "Invalid requestId format (alphanumeric, underscore, dash only)",
        });
      }
      result = await runCmd(OPENCLAW_NODE, clawArgs(["devices", "approve", requestId]));
    } else if (command === "openclaw.plugins.list") {
      result = await runCmd(OPENCLAW_NODE, clawArgs(["plugins", "list"]));
    } else if (command === "openclaw.plugins.enable") {
      // arg is the plugin name
      const pluginName = arg?.trim();
      if (!pluginName) {
        return res.status(400).json({
          ok: false,
          error: "Plugin name required",
        });
      }
      // Validate plugin name format (alphanumeric, underscore, dash)
      if (!/^[A-Za-z0-9_-]+$/.test(pluginName)) {
        return res.status(400).json({
          ok: false,
          error: "Invalid plugin name format (alphanumeric, underscore, dash only)",
        });
      }
      result = await runCmd(OPENCLAW_NODE, clawArgs(["plugins", "enable", pluginName]));
    } else {
      // Should never reach here due to allowlist check
      return res.status(500).json({
        ok: false,
        error: "Internal error: command allowlisted but not implemented",
      });
    }

    // Apply secret redaction to all output
    const output = redactSecrets(result.output || "");

    return res.json({
      ok: result.code === 0,
      output,
      exitCode: result.code,
    });
  } catch (err) {
    console.error("[/setup/api/console/run] error:", err);
    return res.status(500).json({
      ok: false,
      error: `Internal error: ${String(err)}`,
    });
  }
});

app.get("/setup/api/debug", requireSetupAuth, async (_req, res) => {
  const v = await runCmd(OPENCLAW_NODE, clawArgs(["--version"]));
  const help = await runCmd(
    OPENCLAW_NODE,
    clawArgs(["channels", "add", "--help"]),
  );
  res.json({
    wrapper: {
      node: process.version,
      port: PORT,
      stateDir: STATE_DIR,
      workspaceDir: WORKSPACE_DIR,
      configPath: configPath(),
      gatewayTokenFromEnv: Boolean(process.env.OPENCLAW_GATEWAY_TOKEN?.trim()),
      gatewayTokenPersisted: fs.existsSync(
        path.join(STATE_DIR, "gateway.token"),
      ),
      railwayCommit: process.env.RAILWAY_GIT_COMMIT_SHA || null,
    },
    openclaw: {
      entry: OPENCLAW_ENTRY,
      node: OPENCLAW_NODE,
      version: v.output.trim(),
      channelsAddHelpIncludesTelegram: help.output.includes("telegram"),
    },
  });
});

// ========== MULTI-MODEL CONFIGURATION FOR COST EFFICIENCY ==========
// Allows configuring multiple AI models so cheaper models handle simple tasks
// while expensive models handle complex ones — significant cost savings.

// ========== SMART MODEL ROUTING ==========
// Loads config/main.json (or custom config) and applies intelligent model selection
// based on task complexity, token count, and attachment type.

const CONFIG_DIR = path.join(process.cwd(), "config");

function loadMainConfig() {
  const cfgPath = path.join(CONFIG_DIR, "main.json");
  try {
    const raw = fs.readFileSync(cfgPath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`[config] could not load config/main.json: ${err.code || err.message}`);
    return null;
  }
}

/**
 * Smart model selection: picks optimal model based on task characteristics.
 * Returns the model identifier string, or null to use the default.
 */
function selectModelForTask(mainConfig, taskHints = {}) {
  if (!mainConfig?.models?.routing?.enabled) return null;

  const rules = mainConfig.models.routing.rules || [];
  const { inputTokens, complexity, hasAttachment, attachmentType } = taskHints;

  for (const rule of rules) {
    const cond = rule.condition || {};

    // Token-count rule
    if (cond.maxInputTokens != null && inputTokens != null) {
      if (inputTokens <= cond.maxInputTokens) {
        debug(`[routing] matched rule "${rule.name}" (tokens=${inputTokens} <= ${cond.maxInputTokens})`);
        return rule.model;
      }
    }

    // Attachment / multimodal rule
    if (cond.hasAttachment && cond.attachmentType) {
      if (hasAttachment && attachmentType === cond.attachmentType) {
        debug(`[routing] matched rule "${rule.name}" (attachment=${attachmentType})`);
        return rule.model;
      }
    }

    // Complexity rule
    if (cond.complexity && complexity) {
      if (cond.complexity === complexity) {
        debug(`[routing] matched rule "${rule.name}" (complexity=${complexity})`);
        return rule.model;
      }
    }
  }

  return null; // no rule matched — use primary
}

// ========== DAILY COST TRACKER (in-memory, resets at midnight UTC) ==========
const costTracker = {
  dailySpendUsd: 0,
  lastResetDate: new Date().toISOString().slice(0, 10),
  alertSent: false,
  // Per-model breakdown
  modelStats: {},   // { [model]: { requests, inputTokens, outputTokens, costUsd } }
  routingStats: {}, // { [ruleName]: hitCount }
  // Hourly spend for sparkline charts (last 24 hours)
  hourlySpend: [],  // [{ hour: "HH", costUsd, requests }]
  startedAt: Date.now(),

  _ensureModel(model) {
    if (!this.modelStats[model]) {
      this.modelStats[model] = { requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
    }
  },

  _currentHourKey() {
    return new Date().toISOString().slice(11, 13); // "HH"
  },

  reset() {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.lastResetDate) {
      console.log(`[cost] daily reset: spent $${this.dailySpendUsd.toFixed(4)} on ${this.lastResetDate}`);
      this.dailySpendUsd = 0;
      this.lastResetDate = today;
      this.alertSent = false;
      this.modelStats = {};
      this.routingStats = {};
      this.hourlySpend = [];
    }
  },

  recordRouting(ruleName) {
    if (!ruleName) return;
    this.routingStats[ruleName] = (this.routingStats[ruleName] || 0) + 1;
  },

  record(model, inputTokens, outputTokens, mainConfig) {
    this.reset();
    this._ensureModel(model);

    const stats = this.modelStats[model];
    stats.requests += 1;
    stats.inputTokens += inputTokens;
    stats.outputTokens += outputTokens;

    const rates = mainConfig?.costTracking?.models?.[model];
    let cost = 0;
    if (rates) {
      cost =
        (inputTokens / 1_000_000) * (rates.inputPer1M || 0) +
        (outputTokens / 1_000_000) * (rates.outputPer1M || 0);
    }
    stats.costUsd += cost;
    this.dailySpendUsd += cost;

    // Hourly tracking
    const hk = this._currentHourKey();
    let hourEntry = this.hourlySpend.find((h) => h.hour === hk);
    if (!hourEntry) {
      hourEntry = { hour: hk, costUsd: 0, requests: 0 };
      this.hourlySpend.push(hourEntry);
      // Keep max 24 entries
      if (this.hourlySpend.length > 24) this.hourlySpend.shift();
    }
    hourEntry.costUsd += cost;
    hourEntry.requests += 1;

    const budget = mainConfig?.costTracking?.dailyBudgetUsd || 50;
    const threshold = mainConfig?.costTracking?.alertThreshold || 0.8;

    if (!this.alertSent && this.dailySpendUsd >= budget * threshold) {
      console.warn(
        `[cost] ⚠ Daily spend $${this.dailySpendUsd.toFixed(2)} reached ${Math.round(threshold * 100)}% of $${budget} budget`,
      );
      this.alertSent = true;
    }

    debug(`[cost] +$${cost.toFixed(4)} (${model}) — daily total: $${this.dailySpendUsd.toFixed(4)}`);
  },

  getSummary(mainConfig) {
    this.reset();
    const budget = mainConfig?.costTracking?.dailyBudgetUsd || 50;
    return {
      dailySpendUsd: Math.round(this.dailySpendUsd * 10000) / 10000,
      dailyBudgetUsd: budget,
      percentUsed: Math.round((this.dailySpendUsd / budget) * 10000) / 100,
      date: this.lastResetDate,
    };
  },

  getFullStats(mainConfig) {
    this.reset();
    const budget = mainConfig?.costTracking?.dailyBudgetUsd || 50;
    const totalRequests = Object.values(this.modelStats).reduce((s, m) => s + m.requests, 0);
    const totalInputTokens = Object.values(this.modelStats).reduce((s, m) => s + m.inputTokens, 0);
    const totalOutputTokens = Object.values(this.modelStats).reduce((s, m) => s + m.outputTokens, 0);

    return {
      summary: {
        dailySpendUsd: Math.round(this.dailySpendUsd * 10000) / 10000,
        dailyBudgetUsd: budget,
        percentUsed: Math.round((this.dailySpendUsd / budget) * 10000) / 100,
        totalRequests,
        totalInputTokens,
        totalOutputTokens,
        totalTokens: totalInputTokens + totalOutputTokens,
        date: this.lastResetDate,
        uptimeMs: Date.now() - this.startedAt,
      },
      modelBreakdown: Object.entries(this.modelStats).map(([model, s]) => ({
        model,
        requests: s.requests,
        inputTokens: s.inputTokens,
        outputTokens: s.outputTokens,
        totalTokens: s.inputTokens + s.outputTokens,
        costUsd: Math.round(s.costUsd * 10000) / 10000,
        percentOfSpend: this.dailySpendUsd > 0
          ? Math.round((s.costUsd / this.dailySpendUsd) * 10000) / 100
          : 0,
      })).sort((a, b) => b.costUsd - a.costUsd),
      routingStats: Object.entries(this.routingStats).map(([rule, hits]) => ({
        rule,
        hits,
      })).sort((a, b) => b.hits - a.hits),
      hourlySpend: this.hourlySpend.map((h) => ({
        hour: h.hour,
        costUsd: Math.round(h.costUsd * 10000) / 10000,
        requests: h.requests,
      })),
    };
  },
};

// ========== CONFIG APPLY ENDPOINT ==========
// Reads config/main.json and pushes all settings to openclaw via CLI.

// ========== AGENT SWARM ORCHESTRATOR ==========
// Manages coordinated groups of agents working together on complex tasks.
// Strategies: pipeline (sequential handoff), parallel (concurrent execution)

const swarmOrchestrator = {
  swarms: new Map(),    // id → swarm state
  nextId: 1,
  maxHistory: 50,       // keep last N completed swarms

  _generateId() {
    return `swarm-${Date.now()}-${this.nextId++}`;
  },

  getTemplate(mainConfig, templateId) {
    return mainConfig?.swarms?.templates?.[templateId] || null;
  },

  getTemplates(mainConfig) {
    return mainConfig?.swarms?.templates || {};
  },

  create(templateId, task, mainConfig) {
    const swarmConfig = mainConfig?.swarms || {};
    if (!swarmConfig.enabled) {
      return { error: "Swarms are disabled in config" };
    }

    const activeCount = [...this.swarms.values()].filter(s => s.status === "running").length;
    const maxConcurrent = swarmConfig.maxConcurrentSwarms || 3;
    if (activeCount >= maxConcurrent) {
      return { error: `Max concurrent swarms reached (${maxConcurrent}). Cancel or wait for active swarms to finish.` };
    }

    const template = this.getTemplate(mainConfig, templateId);
    if (!template) {
      return { error: `Unknown swarm template: ${templateId}` };
    }

    // Validate all agents in template exist in config
    const configuredAgents = mainConfig.agents || {};
    for (const step of template.steps) {
      if (!configuredAgents[step.agent]) {
        return { error: `Agent "${step.agent}" in template "${templateId}" is not configured` };
      }
    }

    const id = this._generateId();
    const timeoutMinutes = swarmConfig.defaultTimeoutMinutes || 30;

    const swarm = {
      id,
      templateId,
      templateName: template.name,
      strategy: template.strategy,
      task,
      status: "running",
      createdAt: new Date().toISOString(),
      completedAt: null,
      steps: template.steps.map((step, i) => ({
        index: i,
        agent: step.agent,
        agentName: configuredAgents[step.agent]?.name || step.agent,
        model: configuredAgents[step.agent]?.model || "unknown",
        instruction: step.instruction,
        status: "pending",      // pending | running | completed | failed | cancelled
        startedAt: null,
        completedAt: null,
        output: null,
        error: null,
        costUsd: 0,
      })),
      totalCostUsd: 0,
      result: null,
      error: null,
      timeoutAt: new Date(Date.now() + timeoutMinutes * 60_000).toISOString(),
    };

    this.swarms.set(id, swarm);
    this._pruneHistory();

    // Start execution asynchronously
    this._execute(id, mainConfig).catch(err => {
      console.error(`[swarm] ${id} execution error:`, err.message);
      const s = this.swarms.get(id);
      if (s && s.status === "running") {
        s.status = "failed";
        s.error = err.message;
        s.completedAt = new Date().toISOString();
      }
    });

    return { ok: true, swarmId: id, swarm };
  },

  async _execute(swarmId, mainConfig) {
    const swarm = this.swarms.get(swarmId);
    if (!swarm) return;

    const strategy = swarm.strategy;
    console.log(`[swarm] ${swarmId} starting (${strategy}, ${swarm.steps.length} steps)`);

    try {
      if (strategy === "parallel") {
        await this._executeParallel(swarm, mainConfig);
      } else {
        // pipeline / sequential
        await this._executePipeline(swarm, mainConfig);
      }

      if (swarm.status === "running") {
        swarm.status = "completed";
        swarm.completedAt = new Date().toISOString();
        // Aggregate results
        swarm.result = swarm.steps
          .filter(s => s.status === "completed" && s.output)
          .map(s => `## ${s.agentName} (${s.agent})\n${s.output}`)
          .join("\n\n---\n\n");
        console.log(`[swarm] ${swarmId} completed — cost $${swarm.totalCostUsd.toFixed(4)}`);
      }
    } catch (err) {
      if (swarm.status === "running") {
        swarm.status = "failed";
        swarm.error = err.message;
        swarm.completedAt = new Date().toISOString();
      }
      throw err;
    }
  },

  async _executePipeline(swarm, mainConfig) {
    let previousOutput = `Task: ${swarm.task}`;

    for (const step of swarm.steps) {
      if (swarm.status !== "running") break;

      step.status = "running";
      step.startedAt = new Date().toISOString();

      try {
        const prompt = `${step.instruction}\n\nContext:\n${previousOutput}`;
        const result = await this._dispatchToAgent(step.agent, prompt, mainConfig);

        step.output = result.output;
        step.costUsd = result.costUsd || 0;
        swarm.totalCostUsd += step.costUsd;
        step.status = "completed";
        step.completedAt = new Date().toISOString();
        previousOutput = result.output;
      } catch (err) {
        step.status = "failed";
        step.error = err.message;
        step.completedAt = new Date().toISOString();
        throw err;
      }
    }
  },

  async _executeParallel(swarm, mainConfig) {
    const ctx = `Task: ${swarm.task}`;

    const promises = swarm.steps.map(async (step) => {
      if (swarm.status !== "running") return;

      step.status = "running";
      step.startedAt = new Date().toISOString();

      try {
        const prompt = `${step.instruction}\n\nContext:\n${ctx}`;
        const result = await this._dispatchToAgent(step.agent, prompt, mainConfig);

        step.output = result.output;
        step.costUsd = result.costUsd || 0;
        swarm.totalCostUsd += step.costUsd;
        step.status = "completed";
        step.completedAt = new Date().toISOString();
      } catch (err) {
        step.status = "failed";
        step.error = err.message;
        step.completedAt = new Date().toISOString();
      }
    });

    await Promise.allSettled(promises);

    // If any step failed and none completed, the swarm failed
    const hasCompleted = swarm.steps.some(s => s.status === "completed");
    if (!hasCompleted) {
      const firstError = swarm.steps.find(s => s.error)?.error || "All steps failed";
      throw new Error(firstError);
    }
  },

  async _dispatchToAgent(agentId, prompt, mainConfig) {
    // Dispatch via the internal gateway API
    // The gateway handles actual AI model calls
    const agentConfig = mainConfig?.agents?.[agentId];
    const model = agentConfig?.model || mainConfig?.models?.primary?.model;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 120_000);

      const response = await fetch(`${GATEWAY_TARGET}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${OPENCLAW_GATEWAY_TOKEN}`,
        },
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

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Gateway returned ${response.status}: ${body.slice(0, 200)}`);
      }

      const data = await response.json();
      const output = data?.choices?.[0]?.message?.content || "(no response)";
      const usage = data?.usage || {};
      const inputTokens = usage.prompt_tokens || 0;
      const outputTokens = usage.completion_tokens || 0;

      // Record in cost tracker
      if (model && (inputTokens || outputTokens)) {
        costTracker.record(model, inputTokens, outputTokens, mainConfig);
      }

      const rates = mainConfig?.costTracking?.models?.[model];
      let costUsd = 0;
      if (rates) {
        costUsd = (inputTokens / 1_000_000) * (rates.inputPer1M || 0) +
                  (outputTokens / 1_000_000) * (rates.outputPer1M || 0);
      }

      return { output, costUsd, inputTokens, outputTokens };
    } catch (err) {
      if (err.name === "AbortError") {
        throw new Error(`Agent ${agentId} timed out after 120s`);
      }
      throw err;
    }
  },

  cancel(swarmId) {
    const swarm = this.swarms.get(swarmId);
    if (!swarm) return { error: "Swarm not found" };
    if (swarm.status !== "running") return { error: `Swarm is ${swarm.status}, not running` };

    swarm.status = "cancelled";
    swarm.completedAt = new Date().toISOString();
    for (const step of swarm.steps) {
      if (step.status === "pending" || step.status === "running") {
        step.status = "cancelled";
        step.completedAt = new Date().toISOString();
      }
    }
    console.log(`[swarm] ${swarmId} cancelled`);
    return { ok: true };
  },

  getAll() {
    return [...this.swarms.values()]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  },

  getActive() {
    return this.getAll().filter(s => s.status === "running");
  },

  get(swarmId) {
    return this.swarms.get(swarmId) || null;
  },

  getStats() {
    const all = this.getAll();
    const active = all.filter(s => s.status === "running");
    const completed = all.filter(s => s.status === "completed");
    const failed = all.filter(s => s.status === "failed");
    const cancelled = all.filter(s => s.status === "cancelled");
    const totalCost = all.reduce((sum, s) => sum + (s.totalCostUsd || 0), 0);

    return {
      total: all.length,
      active: active.length,
      completed: completed.length,
      failed: failed.length,
      cancelled: cancelled.length,
      totalCostUsd: Math.round(totalCost * 10000) / 10000,
    };
  },

  _pruneHistory() {
    const all = this.getAll();
    const terminal = all.filter(s => s.status !== "running");
    if (terminal.length > this.maxHistory) {
      const toRemove = terminal.slice(this.maxHistory);
      for (const s of toRemove) {
        this.swarms.delete(s.id);
      }
    }
  },
};

// ========== SWARM API ENDPOINTS ==========

// List available swarm templates
app.get("/setup/api/swarms/templates", requireSetupAuth, (_req, res) => {
  const mainConfig = loadMainConfig();
  const templates = swarmOrchestrator.getTemplates(mainConfig);
  const result = Object.entries(templates).map(([id, t]) => ({
    id,
    name: t.name,
    description: t.description,
    strategy: t.strategy,
    agents: t.agents,
    stepCount: t.steps?.length || 0,
  }));
  return res.json({ ok: true, templates: result });
});

// Swarm stats (for dashboard) — must come before :id route
app.get("/setup/api/swarms/stats", requireSetupAuth, (_req, res) => {
  const stats = swarmOrchestrator.getStats();
  const active = swarmOrchestrator.getActive().map(s => ({
    id: s.id,
    templateName: s.templateName,
    strategy: s.strategy,
    task: s.task.length > 80 ? s.task.slice(0, 80) + "..." : s.task,
    stepsTotal: s.steps.length,
    stepsCompleted: s.steps.filter(st => st.status === "completed").length,
    stepsRunning: s.steps.filter(st => st.status === "running").length,
    totalCostUsd: Math.round((s.totalCostUsd || 0) * 10000) / 10000,
    createdAt: s.createdAt,
  }));
  return res.json({ ok: true, stats, activeSwarms: active });
});

// List all swarms (active + history)
app.get("/setup/api/swarms", requireSetupAuth, (_req, res) => {
  const swarms = swarmOrchestrator.getAll().map(s => ({
    id: s.id,
    templateId: s.templateId,
    templateName: s.templateName,
    strategy: s.strategy,
    task: s.task.length > 100 ? s.task.slice(0, 100) + "..." : s.task,
    status: s.status,
    createdAt: s.createdAt,
    completedAt: s.completedAt,
    totalCostUsd: Math.round((s.totalCostUsd || 0) * 10000) / 10000,
    stepsTotal: s.steps.length,
    stepsCompleted: s.steps.filter(st => st.status === "completed").length,
    error: s.error,
  }));
  const stats = swarmOrchestrator.getStats();
  return res.json({ ok: true, swarms, stats });
});

// Get single swarm detail
app.get("/setup/api/swarms/:id", requireSetupAuth, (req, res) => {
  const swarm = swarmOrchestrator.get(req.params.id);
  if (!swarm) return res.status(404).json({ ok: false, error: "Swarm not found" });
  return res.json({ ok: true, swarm });
});

// Spawn a new swarm
app.post("/setup/api/swarms/spawn", requireSetupAuth, (req, res) => {
  const { templateId, task } = req.body || {};

  if (!templateId || typeof templateId !== "string") {
    return res.status(400).json({ ok: false, error: "templateId is required" });
  }
  if (!/^[A-Za-z0-9_-]+$/.test(templateId)) {
    return res.status(400).json({ ok: false, error: "Invalid templateId format" });
  }
  if (!task || typeof task !== "string" || task.trim().length < 3) {
    return res.status(400).json({ ok: false, error: "task is required (min 3 characters)" });
  }
  if (task.length > 5000) {
    return res.status(400).json({ ok: false, error: "task too long (max 5000 characters)" });
  }

  if (!isGatewayReady()) {
    return res.status(503).json({ ok: false, error: "Gateway not ready. Start the gateway first." });
  }

  const mainConfig = loadMainConfig();
  if (!mainConfig) {
    return res.status(500).json({ ok: false, error: "config/main.json not found" });
  }

  const result = swarmOrchestrator.create(templateId, task.trim(), mainConfig);
  if (result.error) {
    return res.status(400).json({ ok: false, error: result.error });
  }

  return res.json({
    ok: true,
    swarmId: result.swarmId,
    templateName: result.swarm.templateName,
    strategy: result.swarm.strategy,
    steps: result.swarm.steps.length,
    status: result.swarm.status,
  });
});

// Cancel a running swarm
app.post("/setup/api/swarms/:id/cancel", requireSetupAuth, (req, res) => {
  const result = swarmOrchestrator.cancel(req.params.id);
  if (result.error) {
    return res.status(400).json({ ok: false, error: result.error });
  }
  return res.json({ ok: true, message: "Swarm cancelled" });
});

app.post("/setup/api/config/apply", requireSetupAuth, async (req, res) => {
  if (!isConfigured()) {
    return res.status(400).json({ ok: false, error: "Not configured yet. Run setup first." });
  }

  const mainConfig = loadMainConfig();
  if (!mainConfig) {
    return res.status(404).json({ ok: false, error: "config/main.json not found or invalid JSON" });
  }

  let extra = "";

  // Apply primary model
  if (mainConfig.models?.primary?.model) {
    const r = await runCmd(OPENCLAW_NODE, clawArgs(["models", "set", mainConfig.models.primary.model]));
    extra += `[models] primary=${mainConfig.models.primary.model} exit=${r.code}\n`;
  }

  // Apply fallback models
  if (Array.isArray(mainConfig.models?.fallback)) {
    const fallbackConfig = mainConfig.models.fallback.map((f) => ({
      model: f.model,
      label: f.label,
    }));
    const r = await runCmd(
      OPENCLAW_NODE,
      clawArgs(["config", "set", "--json", "models.fallback", JSON.stringify(fallbackConfig)]),
    );
    extra += `[models] fallback (${fallbackConfig.length} models) exit=${r.code}\n`;
  }

  // Apply routing rules
  if (mainConfig.models?.routing) {
    const r = await runCmd(
      OPENCLAW_NODE,
      clawArgs(["config", "set", "--json", "models.routing", JSON.stringify(mainConfig.models.routing)]),
    );
    extra += `[models] routing rules exit=${r.code}\n`;
  }

  // Apply cost tracking
  if (mainConfig.costTracking) {
    const r = await runCmd(
      OPENCLAW_NODE,
      clawArgs(["config", "set", "--json", "costTracking", JSON.stringify(mainConfig.costTracking)]),
    );
    extra += `[config] costTracking exit=${r.code}\n`;
  }

  // Apply agents
  if (mainConfig.agents) {
    for (const [agentId, agentCfg] of Object.entries(mainConfig.agents)) {
      // Validate agent ID
      if (!/^[A-Za-z0-9_-]+$/.test(agentId)) {
        extra += `[agents] skipped invalid ID: ${agentId}\n`;
        continue;
      }
      const r = await runCmd(
        OPENCLAW_NODE,
        clawArgs(["config", "set", "--json", `agents.${agentId}`, JSON.stringify(agentCfg)]),
      );
      extra += `[agents] ${agentId} exit=${r.code}\n`;
    }
  }

  // Apply context pruning
  if (mainConfig.contextPruning) {
    const r = await runCmd(
      OPENCLAW_NODE,
      clawArgs(["config", "set", "--json", "contextPruning", JSON.stringify(mainConfig.contextPruning)]),
    );
    extra += `[config] contextPruning exit=${r.code}\n`;
  }

  // Apply caching
  if (mainConfig.caching) {
    const r = await runCmd(
      OPENCLAW_NODE,
      clawArgs(["config", "set", "--json", "caching", JSON.stringify(mainConfig.caching)]),
    );
    extra += `[config] caching exit=${r.code}\n`;
  }

  // Apply heartbeat
  if (mainConfig.heartbeat) {
    const r = await runCmd(
      OPENCLAW_NODE,
      clawArgs(["config", "set", "--json", "heartbeat", JSON.stringify(mainConfig.heartbeat)]),
    );
    extra += `[config] heartbeat exit=${r.code}\n`;
  }

  // Apply concurrency
  if (mainConfig.concurrency) {
    const r = await runCmd(
      OPENCLAW_NODE,
      clawArgs(["config", "set", "--json", "concurrency", JSON.stringify(mainConfig.concurrency)]),
    );
    extra += `[config] concurrency exit=${r.code}\n`;
  }

  // Apply timeouts
  if (mainConfig.timeouts) {
    const r = await runCmd(
      OPENCLAW_NODE,
      clawArgs(["config", "set", "--json", "timeouts", JSON.stringify(mainConfig.timeouts)]),
    );
    extra += `[config] timeouts exit=${r.code}\n`;
  }

  // Apply monitoring
  if (mainConfig.monitoring) {
    const r = await runCmd(
      OPENCLAW_NODE,
      clawArgs(["config", "set", "--json", "monitoring", JSON.stringify(mainConfig.monitoring)]),
    );
    extra += `[config] monitoring exit=${r.code}\n`;
  }

  // Apply integrations
  if (mainConfig.integrations) {
    const r = await runCmd(
      OPENCLAW_NODE,
      clawArgs(["config", "set", "--json", "integrations", JSON.stringify(mainConfig.integrations)]),
    );
    extra += `[config] integrations exit=${r.code}\n`;
  }

  // Apply swarm concurrency settings
  if (mainConfig.swarms) {
    const swarmMeta = {
      enabled: mainConfig.swarms.enabled,
      maxConcurrentSwarms: mainConfig.swarms.maxConcurrentSwarms,
      defaultTimeoutMinutes: mainConfig.swarms.defaultTimeoutMinutes,
    };
    const r = await runCmd(
      OPENCLAW_NODE,
      clawArgs(["config", "set", "--json", "swarms", JSON.stringify(swarmMeta)]),
    );
    extra += `[config] swarms (${Object.keys(mainConfig.swarms.templates || {}).length} templates) exit=${r.code}\n`;
  }

  // Restart gateway to apply everything
  try {
    await restartGateway();
    extra += "[gateway] restarted to apply config/main.json\n";
  } catch (err) {
    extra += `[gateway] restart failed: ${err.message}\n`;
  }

  return res.json({ ok: true, output: redactSecrets(extra) });
});

// Cost tracking summary endpoint
app.get("/setup/api/costs", requireSetupAuth, (_req, res) => {
  const mainConfig = loadMainConfig();
  return res.json({ ok: true, ...costTracker.getSummary(mainConfig) });
});

// Full dashboard stats endpoint — per-model breakdown, routing hits, hourly chart
app.get("/setup/api/dashboard/stats", requireSetupAuth, (_req, res) => {
  const mainConfig = loadMainConfig();
  const fullStats = costTracker.getFullStats(mainConfig);

  // Include config-level info for the dashboard
  const configInfo = mainConfig ? {
    primaryModel: mainConfig.models?.primary?.model || null,
    fallbackModels: (mainConfig.models?.fallback || []).map((f) => f.model),
    routingEnabled: mainConfig.models?.routing?.enabled || false,
    routingRules: (mainConfig.models?.routing?.rules || []).map((r) => ({
      name: r.name,
      description: r.description,
      model: r.model,
    })),
    agents: Object.entries(mainConfig.agents || {}).map(([id, a]) => ({
      id,
      name: a.name,
      role: a.role,
      model: a.model,
    })),
    costRates: mainConfig.costTracking?.models || {},
    dailyBudgetUsd: mainConfig.costTracking?.dailyBudgetUsd || 50,
    alertThreshold: mainConfig.costTracking?.alertThreshold || 0.8,
    concurrency: mainConfig.concurrency || {},
    contextPruning: mainConfig.contextPruning || {},
    caching: mainConfig.caching || {},
    heartbeat: mainConfig.heartbeat || {},
  } : null;

  // Gateway status
  const gateway = {
    configured: isConfigured(),
    running: isGatewayReady(),
    starting: isGatewayStarting(),
    lastError: lastGatewayError,
    lastExit: lastGatewayExit,
  };

  // Swarm data
  const swarmStats = swarmOrchestrator.getStats();
  const activeSwarms = swarmOrchestrator.getActive().map(s => ({
    id: s.id,
    templateName: s.templateName,
    strategy: s.strategy,
    task: s.task.length > 80 ? s.task.slice(0, 80) + "..." : s.task,
    stepsTotal: s.steps.length,
    stepsCompleted: s.steps.filter(st => st.status === "completed").length,
    stepsRunning: s.steps.filter(st => st.status === "running").length,
    totalCostUsd: Math.round((s.totalCostUsd || 0) * 10000) / 10000,
    createdAt: s.createdAt,
  }));

  // Swarm templates
  const swarmTemplates = Object.entries(mainConfig?.swarms?.templates || {}).map(([id, t]) => ({
    id,
    name: t.name,
    description: t.description,
    strategy: t.strategy,
    agents: t.agents,
    stepCount: t.steps?.length || 0,
  }));

  // Smart Router stats — merge into dashboard data
  let smartRouterData = null;
  try {
    const sr = getSmartRouterInstance();
    const srSummary = sr.getDailySummary();
    const srModelStats = sr.getModelStats();
    const srStatus = sr.getStatus();
    const srEntries = sr.costTracker.getEntries();

    // Build per-model breakdown from smart router logs
    const srModelBreakdown = {};
    for (const entry of srEntries) {
      const key = entry.selected_model || "unknown";
      if (!srModelBreakdown[key]) {
        srModelBreakdown[key] = { requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, type: entry.model_type };
      }
      srModelBreakdown[key].requests += 1;
      srModelBreakdown[key].inputTokens += entry.input_tokens || 0;
      srModelBreakdown[key].outputTokens += entry.output_tokens || 0;
      srModelBreakdown[key].costUsd += entry.total_cost || 0;
    }

    // Build hourly breakdown from smart router logs
    const srHourly = {};
    for (const entry of srEntries) {
      const hour = entry.timestamp?.slice(11, 13) || "00";
      if (!srHourly[hour]) srHourly[hour] = { hour, costUsd: 0, requests: 0 };
      srHourly[hour].costUsd += entry.total_cost || 0;
      srHourly[hour].requests += 1;
    }

    smartRouterData = {
      summary: srSummary,
      modelHealth: srModelStats,
      status: srStatus,
      modelBreakdown: Object.entries(srModelBreakdown).map(([model, s]) => ({
        model,
        requests: s.requests,
        inputTokens: s.inputTokens,
        outputTokens: s.outputTokens,
        totalTokens: s.inputTokens + s.outputTokens,
        costUsd: Math.round(s.costUsd * 10000) / 10000,
        modelType: s.type,
      })).sort((a, b) => b.requests - a.requests),
      hourlySpend: Object.values(srHourly).sort((a, b) => a.hour.localeCompare(b.hour)),
    };

    // Merge smart-router stats into the main fullStats so the dashboard shows them
    // Add smart-router model usage into modelBreakdown
    for (const srModel of smartRouterData.modelBreakdown) {
      const existing = fullStats.modelBreakdown.find((m) => m.model === srModel.model);
      if (existing) {
        existing.requests += srModel.requests;
        existing.inputTokens += srModel.inputTokens;
        existing.outputTokens += srModel.outputTokens;
        existing.totalTokens += srModel.totalTokens;
        existing.costUsd += srModel.costUsd;
      } else {
        fullStats.modelBreakdown.push(srModel);
      }
    }
    fullStats.modelBreakdown.sort((a, b) => b.requests - a.requests);

    // Merge into summary totals
    fullStats.summary.totalRequests += srSummary.totalTasks || 0;
    fullStats.summary.dailySpendUsd += srSummary.totalCost || 0;
    const budget = fullStats.summary.dailyBudgetUsd || 50;
    fullStats.summary.percentUsed = Math.round((fullStats.summary.dailySpendUsd / budget) * 10000) / 100;

    // Merge hourly spend
    for (const h of smartRouterData.hourlySpend) {
      const existing = fullStats.hourlySpend.find((e) => e.hour === h.hour);
      if (existing) {
        existing.costUsd += h.costUsd;
        existing.requests += h.requests;
      } else {
        fullStats.hourlySpend.push(h);
      }
    }
    fullStats.hourlySpend.sort((a, b) => a.hour.localeCompare(b.hour));

    // Recalculate token totals
    const allModels = fullStats.modelBreakdown;
    fullStats.summary.totalInputTokens = allModels.reduce((s, m) => s + (m.inputTokens || 0), 0);
    fullStats.summary.totalOutputTokens = allModels.reduce((s, m) => s + (m.outputTokens || 0), 0);
    fullStats.summary.totalTokens = fullStats.summary.totalInputTokens + fullStats.summary.totalOutputTokens;

    // Recalculate percentOfSpend
    const totalSpend = fullStats.summary.dailySpendUsd;
    for (const m of fullStats.modelBreakdown) {
      m.percentOfSpend = totalSpend > 0 ? Math.round((m.costUsd / totalSpend) * 10000) / 100 : 0;
    }
  } catch (err) {
    console.warn(`[dashboard] smart-router stats unavailable: ${err.message}`);
  }

  return res.json({
    ok: true,
    ...fullStats,
    config: configInfo,
    gateway,
    swarmStats,
    activeSwarms,
    swarmTemplates,
    smartRouter: smartRouterData,
  });
});

// Dashboard page
app.get("/dashboard", requireSetupAuth, (_req, res) => {
  res.sendFile(path.join(process.cwd(), "src", "public", "dashboard.html"));
});

// Model routing preview — test which model would be selected for given task hints
app.post("/setup/api/models/route", requireSetupAuth, (req, res) => {
  const mainConfig = loadMainConfig();
  if (!mainConfig) {
    return res.status(404).json({ ok: false, error: "config/main.json not found" });
  }
  const { inputTokens, complexity, hasAttachment, attachmentType } = req.body || {};
  const selected = selectModelForTask(mainConfig, { inputTokens, complexity, hasAttachment, attachmentType });
  const primary = mainConfig.models?.primary?.model || "unknown";
  return res.json({
    ok: true,
    selectedModel: selected || primary,
    matchedRule: selected ? "routing-rule" : "primary-default",
    primary,
  });
});

app.get("/setup/api/models", requireSetupAuth, async (_req, res) => {
  if (!isConfigured()) {
    return res.json({ ok: false, error: "Not configured yet. Run setup first." });
  }
  const result = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "models"]));
  let models = null;
  try {
    models = JSON.parse(result.output.trim());
  } catch {
    // May return non-JSON — that's OK, we just show raw
  }
  return res.json({ ok: true, models, raw: result.output.trim() });
});

app.post("/setup/api/models", requireSetupAuth, async (req, res) => {
  if (!isConfigured()) {
    return res.status(400).json({ ok: false, error: "Not configured yet. Run setup first." });
  }

  const { primaryModel, fallbackModel, customProviders } = req.body || {};
  let extra = "";

  // Set primary model (the main/default model)
  if (primaryModel?.trim()) {
    const r = await runCmd(OPENCLAW_NODE, clawArgs(["models", "set", primaryModel.trim()]));
    extra += `[models] primary=${primaryModel.trim()} exit=${r.code}\n${r.output || ""}`;
  }

  // Configure custom providers (e.g., Ollama, local vLLM, OpenRouter with specific models)
  if (Array.isArray(customProviders) && customProviders.length > 0) {
    for (const provider of customProviders) {
      if (!provider.id?.trim() || !provider.baseUrl?.trim()) continue;

      // Validate provider ID (alphanumeric + underscore + dash)
      if (!/^[A-Za-z0-9_-]+$/.test(provider.id.trim())) {
        extra += `[provider] skipped invalid ID: ${provider.id}\n`;
        continue;
      }

      // Validate URL
      try {
        new URL(provider.baseUrl.trim());
      } catch {
        extra += `[provider] skipped invalid URL for ${provider.id}\n`;
        continue;
      }

      const providerConfig = {
        id: provider.id.trim(),
        baseUrl: provider.baseUrl.trim(),
      };
      if (provider.apiKeyEnvVar?.trim()) {
        providerConfig.apiKeyEnvVar = provider.apiKeyEnvVar.trim();
      }
      if (provider.models?.trim()) {
        providerConfig.models = provider.models.trim().split(",").map(m => m.trim()).filter(Boolean);
      }

      const setResult = await runCmd(
        OPENCLAW_NODE,
        clawArgs([
          "config",
          "set",
          "--json",
          `providers.${provider.id.trim()}`,
          JSON.stringify(providerConfig),
        ]),
      );
      extra += `[provider] ${provider.id.trim()} exit=${setResult.code}\n`;
    }
  }

  // Set fallback/secondary model for cost efficiency routing
  if (fallbackModel?.trim()) {
    // Configure as a model alias or routing rule depending on openclaw version
    const r = await runCmd(
      OPENCLAW_NODE,
      clawArgs([
        "config",
        "set",
        "--json",
        "models.fallback",
        JSON.stringify({ model: fallbackModel.trim() }),
      ]),
    );
    extra += `[models] fallback=${fallbackModel.trim()} exit=${r.code}\n${r.output || ""}`;
  }

  // Restart gateway to pick up new model config
  if (extra) {
    try {
      await restartGateway();
      extra += "[gateway] restarted to apply model changes\n";
    } catch (err) {
      extra += `[gateway] restart failed: ${err.message}\n`;
    }
  }

  return res.json({ ok: true, output: redactSecrets(extra) });
});

const VALID_PAIRING_CHANNELS = new Set(["telegram", "discord", "slack"]);

app.post("/setup/api/pairing/approve", requireSetupAuth, async (req, res) => {
  const { channel, code } = req.body || {};
  if (!channel || !code) {
    return res
      .status(400)
      .json({ ok: false, error: "Missing channel or code" });
  }
  const ch = String(channel).toLowerCase().trim();
  if (!VALID_PAIRING_CHANNELS.has(ch)) {
    return res.status(400).json({
      ok: false,
      error: `Invalid channel: must be one of ${[...VALID_PAIRING_CHANNELS].join(", ")}`,
    });
  }
  const cd = String(code).trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(cd)) {
    return res.status(400).json({
      ok: false,
      error: "Invalid pairing code format (alphanumeric, 1-64 chars)",
    });
  }
  const r = await runCmd(
    OPENCLAW_NODE,
    clawArgs(["pairing", "approve", ch, cd]),
  );
  return res
    .status(r.code === 0 ? 200 : 500)
    .json({ ok: r.code === 0, output: r.output });
});

app.get("/setup/api/devices", requireSetupAuth, async (_req, res) => {
  const result = await runCmd(
    OPENCLAW_NODE,
    clawArgs(["devices", "list", "--json", "--token", OPENCLAW_GATEWAY_TOKEN]),
  );
  const raw = result.output || "";

  let data = null;
  try {
    data = JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        data = JSON.parse(raw.slice(start, end + 1));
      } catch {
        data = null;
      }
    }
  }

  return res.json({
    ok: result.code === 0 || Boolean(data),
    data,
    raw,
  });
});

app.post("/setup/api/devices/approve", requireSetupAuth, async (req, res) => {
  const { requestId } = req.body || {};
  const args = ["devices", "approve"];

  if (requestId) {
    const trimmed = String(requestId).trim();
    if (!/^[A-Za-z0-9-]+$/.test(trimmed)) {
      return res.status(400).json({
        ok: false,
        error: "Invalid requestId format",
      });
    }
    args.push(trimmed);
  } else {
    args.push("--latest");
  }

  args.push("--token", OPENCLAW_GATEWAY_TOKEN);

  const result = await runCmd(OPENCLAW_NODE, clawArgs(args));
  return res
    .status(result.code === 0 ? 200 : 500)
    .json({ ok: result.code === 0, output: result.output });
});

app.post("/setup/api/reset", requireSetupAuth, async (_req, res) => {
  try {
    fs.rmSync(configPath(), { force: true });
    res
      .type("text/plain")
      .send("OK - deleted config file. You can rerun setup now.");
  } catch (err) {
    res.status(500).type("text/plain").send(String(err));
  }
});

app.post("/setup/api/doctor", requireSetupAuth, async (_req, res) => {
  const args = ["doctor", "--non-interactive", "--repair"];
  const result = await runCmd(OPENCLAW_NODE, clawArgs(args));
  return res.status(result.code === 0 ? 200 : 500).json({
    ok: result.code === 0,
    output: result.output,
  });
});

// ========== WEB TUI ROUTE ==========
app.get("/tui", requireSetupAuth, (_req, res) => {
  if (!ENABLE_WEB_TUI) {
    return res
      .status(403)
      .type("text/plain")
      .send("Web TUI is disabled. Set ENABLE_WEB_TUI=true to enable it.");
  }
  if (!isConfigured()) {
    return res.redirect("/setup");
  }
  res.sendFile(path.join(process.cwd(), "src", "public", "tui.html"));
});

app.get("/setup/export", requireSetupAuth, async (_req, res) => {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

  res.setHeader("content-type", "application/gzip");
  res.setHeader(
    "content-disposition",
    `attachment; filename="openclaw-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.tar.gz"`,
  );

  // Prefer exporting from a common /data root so archives are easy to inspect and restore.
  // This preserves dotfiles like /data/.openclaw/openclaw.json.
  const stateAbs = path.resolve(STATE_DIR);
  const workspaceAbs = path.resolve(WORKSPACE_DIR);

  const dataRoot = "/data";
  const underData = (p) => p === dataRoot || p.startsWith(dataRoot + path.sep);

  let cwd = "/";
  let paths = [stateAbs, workspaceAbs].map((p) => p.replace(/^\//, ""));

  if (underData(stateAbs) && underData(workspaceAbs)) {
    cwd = dataRoot;
    // We export relative to /data so the archive contains: .openclaw/... and workspace/...
    paths = [
      path.relative(dataRoot, stateAbs) || ".",
      path.relative(dataRoot, workspaceAbs) || ".",
    ];
  }

  const tar = childProcess.spawn(
    "tar",
    ["-czf", "-", "--dereference", ...paths],
    { cwd, stdio: ["ignore", "pipe", "pipe"] },
  );

  tar.stderr.on("data", (d) =>
    console.warn("[export] tar stderr:", d.toString()),
  );
  tar.on("error", (err) => {
    console.error("[export] tar error:", err);
    if (!res.headersSent) res.status(500).end();
  });

  tar.stdout.pipe(res);
});

const proxy = httpProxy.createProxyServer({
  target: GATEWAY_TARGET,
  ws: true,
  xfwd: true,
  proxyTimeout: 120_000,
  timeout: 120_000,
  changeOrigin: true,
});

// Prevent proxy errors from crashing the wrapper.
// Common errors: ECONNREFUSED (gateway not ready), ECONNRESET (client disconnect).
proxy.on("error", (err, _req, res) => {
  console.error("[proxy]", err);
  if (res && typeof res.headersSent !== "undefined" && !res.headersSent) {
    res.writeHead(503, { "Content-Type": "text/html" });
    try {
      const html = fs.readFileSync(
        path.join(process.cwd(), "src", "public", "loading.html"),
        "utf8",
      );
      res.end(html);
    } catch {
      res.end("Gateway unavailable. Retrying...");
    }
  }
});

// Determine the origin the gateway expects: the public-facing URL when deployed,
// falling back to the internal target for local dev.
const PROXY_ORIGIN = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : GATEWAY_TARGET;

proxy.on("proxyReq", (proxyReq, req, res) => {
  proxyReq.setHeader("Authorization", `Bearer ${OPENCLAW_GATEWAY_TOKEN}`);
  proxyReq.setHeader("Origin", PROXY_ORIGIN);
});

proxy.on("proxyReqWs", (proxyReq, req, socket, options, head) => {
  proxyReq.setHeader("Authorization", `Bearer ${OPENCLAW_GATEWAY_TOKEN}`);
  proxyReq.setHeader("Origin", PROXY_ORIGIN);
});

// Token injection for /openclaw Control UI is handled by the proxy event handlers
// (proxyReq/proxyReqWs) which inject the Authorization header server-side.
// We do NOT redirect with ?token= in the URL to avoid leaking the gateway token
// into browser history, server logs, and Referer headers.

app.use(async (req, res) => {
  // Auto-setup: if not configured, run headless onboarding from env vars
  if (!isConfigured() && !req.path.startsWith("/setup")) {
    if (!autoSetupRunning && !autoSetupDone) {
      // Fire auto-setup in background — don't await, show loading page
      runAutoSetup().catch((err) =>
        console.error(`[auto-setup] background error: ${err.message}`),
      );
    }
    return res
      .status(503)
      .sendFile(path.join(process.cwd(), "src", "public", "loading.html"));
  }

  if (isConfigured()) {
    if (!isGatewayReady()) {
      try {
        await ensureGatewayRunning();
      } catch {
        return res
          .status(503)
          .sendFile(path.join(process.cwd(), "src", "public", "loading.html"));
      }

      if (!isGatewayReady()) {
        return res
          .status(503)
          .sendFile(path.join(process.cwd(), "src", "public", "loading.html"));
      }
    }
  }

  // Token is injected server-side via proxy event handlers — no URL leak needed.
  return proxy.web(req, res, { target: GATEWAY_TARGET });
});

const server = app.listen(PORT, () => {
  console.log(`[wrapper] listening on port ${PORT}`);
  console.log(`[wrapper] admin panel: http://localhost:${PORT}/setup`);
  console.log(`[wrapper] web TUI: ${ENABLE_WEB_TUI ? "enabled" : "disabled"}`);
  console.log(`[wrapper] configured: ${isConfigured()}`);

  // Harden state dir for OpenClaw and avoid missing credentials dir on fresh volumes.
  try {
    fs.mkdirSync(path.join(STATE_DIR, "credentials"), { recursive: true, mode: 0o700 });
  } catch {}
  try {
    fs.chmodSync(STATE_DIR, 0o700);
  } catch {}
  try {
    fs.chmodSync(path.join(STATE_DIR, "credentials"), 0o700);
  } catch {}

  if (isConfigured()) {
    // Already configured — start gateway immediately
    (async () => {
      try {
        console.log("[wrapper] running openclaw doctor --fix...");
        const dr = await runCmd(OPENCLAW_NODE, clawArgs(["doctor", "--fix"]));
        console.log(`[wrapper] doctor --fix exit=${dr.code}`);
        if (dr.output) console.log(dr.output);
      } catch (err) {
        console.warn(`[wrapper] doctor --fix failed: ${err.message}`);
      }
      await ensureGatewayRunning();
    })().catch((err) => {
      console.error(`[wrapper] failed to start gateway at boot: ${err.message}`);
    });
  } else {
    // Not configured — run auto-setup from environment variables
    console.log("[wrapper] Not configured — starting auto-setup from env vars...");
    runAutoSetup().catch((err) => {
      console.error(`[wrapper] auto-setup failed at boot: ${err.message}`);
    });
  }
});

const tuiWss = createTuiWebSocketServer(server);

server.on("upgrade", async (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/tui/ws") {
    if (!ENABLE_WEB_TUI) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }

    if (!verifyTuiAuth(req)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"OpenClaw TUI\"\r\n\r\n");
      socket.destroy();
      return;
    }

    if (activeTuiSession) {
      socket.write("HTTP/1.1 409 Conflict\r\n\r\n");
      socket.destroy();
      return;
    }

    tuiWss.handleUpgrade(req, socket, head, (ws) => {
      tuiWss.emit("connection", ws, req);
    });
    return;
  }

  if (!isConfigured()) {
    socket.destroy();
    return;
  }
  try {
    await ensureGatewayRunning();
  } catch (err) {
    console.warn(`[websocket] gateway not ready: ${err.message}`);
    socket.destroy();
    return;
  }
  proxy.ws(req, socket, head, {
    target: GATEWAY_TARGET,
    headers: {
      Authorization: `Bearer ${OPENCLAW_GATEWAY_TOKEN}`,
      Origin: PROXY_ORIGIN,
    },
  });
});

async function gracefulShutdown(signal) {
  console.log(`[wrapper] received ${signal}, shutting down`);
  shuttingDown = true;

  if (setupRateLimiter.cleanupInterval) {
    clearInterval(setupRateLimiter.cleanupInterval);
  }
  if (publicRateLimiter.cleanup) {
    clearInterval(publicRateLimiter.cleanup);
  }

  if (activeTuiSession) {
    try {
      activeTuiSession.ws.close(1001, "Server shutting down");
      if (activeTuiSession.pty) activeTuiSession.pty.kill();
    } catch {}
    activeTuiSession = null;
  }

  server.close();

  if (gatewayProc) {
    try {
      gatewayProc.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => gatewayProc.on("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
      if (gatewayProc && !gatewayProc.killed) {
        gatewayProc.kill("SIGKILL");
      }
    } catch (err) {
      console.warn(`[wrapper] error killing gateway: ${err.message}`);
    }
  }

  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
