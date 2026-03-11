# Changelog

All notable changes to the **OpenClaw Railway Template** are documented here.

---

## [Unreleased] — 2026-03-11

### Phase 1: Security Review & Infrastructure Fixes

#### Fixed
- **Node engine mismatch** — `package.json` engines field changed from `>=24` to `>=22` to match Dockerfile's `node:22-bookworm` base image.
- **Railway healthcheck timeout** — Reduced from 300s to 180s in `railway.toml` to accommodate cold starts without excessive wait.
- **Dockerfile bloat** — `build-essential` is now removed after `npm install` to save ~200MB in production image.

#### Security
- **Input validation for pairing** — Channel and code fields validated against allowlists (`VALID_PAIRING_CHANNELS` set, regex `^[A-Za-z0-9_-]{1,64}$`) to prevent command injection in `openclaw pairing approve`.
- **Credentials directory permissions** — Set to `0o700` (owner-only) instead of `0o755`.
- **Security headers** — Added `X-Frame-Options`, `X-Content-Type-Options`, `X-XSS-Protection`, `Referrer-Policy`, `Permissions-Policy`, `Strict-Transport-Security` (Railway), and `Content-Security-Policy` (setup/TUI pages).
- **Secret redaction** — `redactSecrets()` function strips 10+ token patterns (OpenAI, Anthropic, GitHub, Slack, Telegram, Discord, Google, OpenRouter, Bearer tokens, custom gateway token) from all debug/console output.
- **Debug logging guard** — `debug()` helper only logs when `OPENCLAW_TEMPLATE_DEBUG=true`, preventing token leaks in production.
- **Timing-safe auth** — `requireSetupAuth()` uses constant-time comparison to prevent timing attacks on SETUP_PASSWORD.
- **Rate limiting** — Two-tier sliding window: 30 req/10s per IP (public endpoints), 50 req/60s per IP (setup endpoints).

---

### Phase 2: Gateway Lifecycle & Resilience

#### Added
- **Crash loop prevention** — Exponential backoff for gateway restarts: `min(2000ms × 2^(n-1), 60000ms)`, max 10 retries. Counter resets on successful health check.
- **Debug breadcrumbs** — Tracks `lastGatewayError`, `lastGatewayExit` (code + signal + timestamp), `lastDoctorOutput`, `lastDoctorAt` for diagnostics.
- **Auto Doctor** — Runs `openclaw doctor --fix` automatically on gateway failure, rate-limited to once per 5 minutes.
- **Token sync on every start** — Wrapper token synced to `gateway.auth.token` in `openclaw.json` before each gateway spawn with read-back verification.
- **Environment variable migration** — Auto-migrates `CLAWDBOT_*` → `OPENCLAW_*` and `MOLTBOT_*` → `OPENCLAW_*` with deprecation warnings.
- **Legacy config file migration** — Auto-renames `moltbot.json` / `clawdbot.json` → `openclaw.json` with existence checks.
- **Enhanced `runCmd()`** — 120s default timeout, SIGTERM → SIGKILL escalation, returns exit code 124 for timeout (GNU timeout compatible).
- **Railway proxy trust** — Sets `gateway.trustedProxies=["127.0.0.1"]` for reverse proxy compatibility.

---

### Phase 3: Health Checks & Monitoring

#### Added
- **`GET /healthz`** — Public (no auth) health endpoint returning `{ok, gateway: "ready|starting|unconfigured"}`. TCP-based gateway probe for reliable up/down detection.
- **`GET /setup/healthz`** — Authenticated endpoint with full diagnostics: wrapper state, configured flag, gateway running/starting/reachable status.
- **Gateway readiness polling** — Checks multiple endpoints (`/openclaw`, `/`, `/health`) with 60s timeout to handle different OpenClaw builds.

---

### Phase 4: Debug Console & Diagnostics

#### Added
- **`POST /setup/api/console/run`** — Execute commands from a strict allowlist of 13 commands:
  - Gateway lifecycle: `restart`, `stop`, `start`
  - OpenClaw CLI: `version`, `status`, `health`, `doctor`, `logs --tail`
  - Config: `get` (any path)
  - Devices: `list`, `approve` (with requestId regex validation)
  - Plugins: `list`, `enable` (with name regex validation)
  - All output redacted via `redactSecrets()`.
- **`GET /setup/api/debug`** — System diagnostics: Node version, ports, state/workspace dirs, config path, OpenClaw version, channel diagnostics, plugin list, auth groups.

---

### Phase 5: Config Editor & Device Pairing

#### Added
- **Config Editor**:
  - `GET /setup/api/config/raw` — Load `openclaw.json` contents.
  - `POST /setup/api/config/raw` — Save config with: 500KB size limit (DoS prevention), timestamped `.bak-*` backups, JSON validation before write, `0o600` file permissions, auto gateway restart.
- **Device Pairing Helper**:
  - `GET /setup/api/devices/pending` — List pending devices (parses requestIds from `openclaw devices list` output).
  - `POST /setup/api/devices/approve` — Approve by requestId with format validation (`^[A-Za-z0-9-]+$`).

---

### Phase 6: Backup Import & Export

#### Added
- **`GET /setup/export`** — Export `.tar.gz` backup of `STATE_DIR` + `WORKSPACE_DIR`, preserving `/data`-relative structure including dotfiles.
- **`POST /setup/import`** — Import `.tar.gz` backup:
  - 250MB max upload size.
  - Path traversal prevention (`isUnderDir()`, `looksSafeTarPath()` rejecting `..`, absolute paths, `C:` patterns).
  - Extracts to `/data` only (Railway volume boundary).
  - Gateway stop before import, restart after.
  - Temp file cleanup on success/failure.
  - Human-readable error messages with file sizes and env var fix suggestions.

---

### Phase 7: Multi-Model Intelligence

#### Added
- **Smart Model Routing** — `selectModelForTask(mainConfig, taskHints)`:
  - Routes by `maxInputTokens` (short queries → cheap models).
  - Routes by `complexity` level (complex tasks → capable models).
  - Routes by `attachmentType` (images → vision models).
  - Returns selected model + matched rule name.
- **Cost Tracker** — `costTracker` object with:
  - Per-model breakdown: requests, inputTokens, outputTokens, costUsd.
  - Routing stats: rule hit counts.
  - Hourly spend: last 24 hours for sparkline charts.
  - Daily reset at midnight UTC.
  - Budget alerts at configurable threshold (default 80%).
  - `getFullStats(mainConfig)` — comprehensive data for dashboard.
- **`POST /setup/api/config/apply`** — Reads `config/main.json` and pushes all settings via `openclaw config set --json`: primary/fallback models, routing rules, cost tracking, agents, context pruning, caching, heartbeat, concurrency, timeouts, monitoring, integrations.
- **`GET /setup/api/costs`** — Daily spend summary.
- **`POST /setup/api/models/route`** — Preview which model would be selected for given task hints.
- **Custom Provider Support** — Add OpenAI-compatible providers (Ollama, vLLM, etc.) with URL/ID/env var/model validation.

#### New Files
- **`config/main.json`** — Full production configuration: 5 models (Claude 3.5 Sonnet primary, Opus/Haiku/GPT-4o/GPT-4o-mini fallback), 4 routing rules, $50/day budget, 4 specialized agents (founder/code/researcher/writer), context pruning, prompt caching, heartbeat, concurrency limits, timeouts, monitoring, Google integrations placeholder.
- **`.env.example`** — Comprehensive environment variable documentation with `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_CREDENTIALS_JSON`, model cost recommendations.
- **`.gitignore`** — Security exclusions: `.env.*`, `config/main.json.backup*`, `*.pem`, `*.key`, `credentials/`, `service-account*.json`.

---

### Phase 8: Dashboard

#### Added
- **`GET /dashboard`** — Real-time monitoring dashboard (auth-protected):
  - **KPI Cards**: Daily spend (with budget progress bar), total requests, total tokens (in/out split), avg cost per request, uptime.
  - **Hourly Spend Chart**: Sparkline bar chart with hover tooltips (cost + request count per hour, last 24h).
  - **Budget Gauge**: SVG donut chart with color thresholds (green → amber at 50% → red at 80%).
  - **Model Usage Breakdown**: Per-model cards with requests, tokens in/out, cost, % of spend, color-coded bars.
  - **Smart Routing Activity**: Configured routing rules with live hit counts and enabled/disabled indicator.
  - **Specialized Agents**: Cards for each configured agent with role descriptions and model badges.
  - **System Configuration**: Primary/fallback models, routing, budget, pruning, caching, heartbeat, concurrency.
  - **Model Pricing Reference**: Table with input/output rates per 1M tokens, relative cost indicator.
  - Auto-refreshes every 30 seconds.
- **`GET /setup/api/dashboard/stats`** — Full stats API: summary, modelBreakdown, routingStats, hourlySpend, config info, gateway status.

#### New Files
- **`src/public/dashboard.html`** — Dashboard frontend (Tailwind CSS, Space Grotesk font, dark theme).

---

### Phase 9: Web TUI

#### Added
- **`GET /tui`** — Browser-based terminal UI (gated by `ENABLE_WEB_TUI` env var):
  - PTY spawning via `node-pty` with `openclaw tui` command.
  - Dynamic resize support.
  - Idle timeout (default 5 min, configurable via `TUI_IDLE_TIMEOUT_MS`).
  - Max session timeout (default 30 min, configurable via `TUI_MAX_SESSION_MS`).
  - WebSocket auth via Basic header or subprotocol fallback.

#### New Files
- **`src/public/tui.html`** — Terminal UI frontend (xterm.js).

---

### Phase 10: Setup Wizard Enhancements

#### Changed
- **Cost guidance** — Added inline cost tips in setup UI for model selection.
- **Telegram plugin auto-enable** — Automatically enables Telegram plugin after channel config.
- **`openclaw doctor --fix`** — Runs after setup for automatic repair.
- **Channel config via `config set --json`** — Bypasses flaky `channels add` CLI command.
- **`allowInsecureAuth`** — Set during onboarding to bypass device pairing (wrapper handles bearer token auth).

---

### Other

#### Added
- **Graceful shutdown** — On SIGTERM/SIGINT: stops auto-restart, clears rate limiter intervals, closes TUI/PTY, closes HTTP server, kills gateway (SIGTERM → 2s → SIGKILL), exits.
- **Proxy error handling** — Friendly 503 page on ECONNREFUSED with references to `/healthz` and Debug Console.
- **CORS origin sync** — `syncAllowedOrigins()` sets `gateway.controlUi.allowedOrigins` to Railway public domain.
- **WebSocket token injection** — Uses `proxyReqWs` event handler (not direct `req.headers` modification) for reliable WebSocket auth with `http-proxy`.
- **`src/public/loading.html`** — Auto-refresh loading page shown during gateway startup.

---

## Architecture Summary

```
User → Railway → Wrapper (Express on PORT)
  ├── /setup/*     → Setup Wizard (Basic auth)
  ├── /dashboard   → Cost & Usage Dashboard (Basic auth)
  ├── /tui         → Web Terminal (Basic auth, ENABLE_WEB_TUI)
  ├── /healthz     → Public health endpoint (no auth)
  └── /*           → Reverse proxy → Internal Gateway (localhost:18789)
                      (Authorization: Bearer injected automatically)
```

**Models (cost-optimized routing)**:
| Model | Role | Input $/1M | Output $/1M |
|-------|------|-----------|-------------|
| Claude 3.5 Sonnet | Primary | $3.00 | $15.00 |
| Claude 3 Opus | Complex tasks | $15.00 | $75.00 |
| Claude 3 Haiku | Short/simple | $0.25 | $1.25 |
| GPT-4o | Fallback | $2.50 | $10.00 |
| GPT-4o-mini | Cheapest | $0.15 | $0.60 |
