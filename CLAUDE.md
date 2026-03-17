# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This is a Railway deployment wrapper for **Openclaw** (an AI coding assistant platform). It provides:

- A web-based setup wizard at `/setup` (protected by `SETUP_PASSWORD`)
- Automatic reverse proxy from public URL → internal Openclaw gateway
- Persistent state via Railway Volume at `/data`
- One-click backup export of configuration and workspace
- Smart AI model routing with cost optimization and circuit breakers
- Prometheus metrics, structured logging, and webhook alerting

The wrapper manages the Openclaw lifecycle: onboarding → gateway startup → traffic proxying.

## Development Commands

```bash
# Local development (requires Openclaw in /openclaw or OPENCLAW_ENTRY set)
npm run dev

# Production start
npm start

# Syntax check
npm run lint

# Run all tests (151 tests across 2 suites)
npm test

# Run only library tests (98 tests)
npm run test:lib

# Run only smart-router tests (53 tests)
npm run test:router

# Local smoke test (requires Docker)
npm run smoke
```

## Docker Build & Local Testing

```bash
# Build the container (builds Openclaw from source)
docker build -t openclaw-railway-template .

# Run locally with volume
docker run --rm -p 8080:8080 \
  -e PORT=8080 \
  -e SETUP_PASSWORD=test \
  -e OPENCLAW_STATE_DIR=/data/.openclaw \
  -e OPENCLAW_WORKSPACE_DIR=/data/workspace \
  -v $(pwd)/.tmpdata:/data \
  openclaw-railway-template

# Access setup wizard
open http://localhost:8080/setup  # password: test
```

## Architecture

### Module Structure

```
src/
├── server.js                  # Main entry: Express bootstrap, route wiring (~750 lines)
├── auto-setup.js              # Provider/channel auto-detection from env vars
├── lib/                       # Core libraries (zero external deps)
│   ├── logger.js              # Structured JSON logging with levels & correlation IDs
│   ├── circuit-breaker.js     # CLOSED → OPEN → HALF_OPEN fault tolerance
│   ├── run-cmd.js             # Process execution with timeout + SIGTERM→SIGKILL
│   ├── rate-limiter.js        # Token-bucket per-IP rate limiting
│   ├── redact.js              # Secret redaction (12 patterns: API keys, tokens, JWTs)
│   ├── alerts.js              # Webhook alerting (Slack/Discord/generic) with cooldown
│   ├── metrics.js             # Prometheus counters/gauges/histograms
│   └── test.js                # 98 unit tests for all lib modules
├── gateway/                   # Gateway lifecycle management
│   ├── lifecycle.js           # GatewayManager (EventEmitter): start/stop/restart/probe
│   ├── proxy.js               # http-proxy creation with token injection
│   └── token.js               # Token resolution: env → file → generate
├── auth/
│   └── middleware.js           # Basic auth middleware + timing-safe comparison
├── smart-router/              # AI model routing with cost optimization
│   ├── config.js              # API keys (getters), model defs, escalation chains
│   ├── task-classifier.js     # Weighted keyword scoring, code detection, hysteresis
│   ├── model-router.js        # Model selection with NVIDIA direct + fallback chains
│   ├── executors.js           # Free (OpenRouter/NVIDIA) + Paid (Anthropic/OpenAI) with circuit breakers
│   ├── cost-tracker.js        # Async JSONL logging, daily summaries, log rotation, budget alerts
│   ├── auto-scaler.js         # Error rate tracking, model auto-disable, alerting
│   ├── index.js               # SmartRouter orchestrator: classify → route → execute → log
│   ├── routes.js              # Express API routes for smart-router
│   └── test.js                # 53 unit tests
└── public/                    # Static assets for setup wizard
    ├── dashboard.html
    ├── setup.html
    ├── styles.css
    └── setup-app.js
```

### Request Flow

1. **User → Railway → Wrapper (Express on PORT)** → routes to:
   - `/healthz` → public health check (rate-limited, no auth)
   - `/metrics` → Prometheus metrics (rate-limited, no auth)
   - `/setup/*` → setup wizard (auth: Basic with `SETUP_PASSWORD`)
   - `/setup/api/smart-router/*` → smart routing API
   - All other routes → proxied to internal gateway

2. **Wrapper → Gateway** (localhost:18789 by default)
   - HTTP/WebSocket reverse proxy via `http-proxy`
   - Automatically injects `Authorization: Bearer <token>` header

### Key Design Patterns

- **Circuit breakers** on all external API calls (OpenRouter, NVIDIA, Anthropic, OpenAI) — prevents cascading failures
- **Structured JSON logging** via `createLogger(component)` — every log line has timestamp, level, component, optional correlation ID
- **Token bucket rate limiting** — per-IP with automatic stale bucket cleanup
- **Async JSONL cost logging** — non-blocking write queue, hourly log rotation
- **Webhook alerting** with 5-minute cooldown dedup — budget warnings, gateway crashes, model failures
- **Prometheus metrics** — HTTP request counts/latency, gateway status, smart-router costs/latency, circuit breaker states
- **Escalation chains** — configurable model fallback: free → NVIDIA direct → paid models

### Lifecycle States

1. **Unconfigured**: No `openclaw.json` exists
   - All non-`/setup` routes redirect to `/setup`
   - User completes setup wizard → runs `openclaw onboard --non-interactive`

2. **Configured**: `openclaw.json` exists
   - GatewayManager spawns `openclaw gateway run` as child process
   - Auto-restart with exponential backoff (2s base, max 60s, max 10 restarts)
   - Auto-doctor on failure with 5-minute cooldown
   - Emits events: `ready`, `exit`, `error`

### Environment Variables

**Required:**

- `SETUP_PASSWORD` — protects `/setup` wizard (min 12 chars recommended)

**Recommended (Railway template defaults):**

- `OPENCLAW_STATE_DIR=/data/.openclaw` — config + credentials
- `OPENCLAW_WORKSPACE_DIR=/data/workspace` — agent workspace

**Optional:**

- `OPENCLAW_GATEWAY_TOKEN` — auth token for gateway (auto-generated if unset)
- `PORT` — wrapper HTTP port (default 8080)
- `INTERNAL_GATEWAY_PORT` — gateway internal port (default 18789)
- `OPENCLAW_ENTRY` — path to `entry.js` (default `/openclaw/dist/entry.js`)
- `LOG_LEVEL` — logging level: debug/info/warn/error/fatal (default: info)
- `OPENCLAW_TEMPLATE_DEBUG` — set `true` for verbose/sensitive debug logging
- `ALERT_WEBHOOK_URL` — webhook URL for alerts (Slack, Discord, or generic)
- `ALERT_WEBHOOK_TYPE` — `slack`, `discord`, or `generic` (default: generic)
- `ALERT_COOLDOWN_MS` — alert dedup cooldown (default: 300000 = 5 min)
- `SMART_ROUTER_LOG_DIR` — override log directory for smart-router JSONL files
- `SMART_ROUTER_DAILY_BUDGET` — daily cost budget in USD (default: 1.00)
- `NVIDIA_API_KEY` — enables NVIDIA direct API for free model routing
- `OPENROUTER_API_KEY` — enables OpenRouter for free model routing
- `ANTHROPIC_API_KEY` — enables Anthropic for paid model routing
- `OPENAI_API_KEY` — enables OpenAI for paid model routing

### Authentication Flow

The wrapper manages a **two-layer auth scheme**:

1. **Setup wizard auth**: Basic auth with `SETUP_PASSWORD` via `src/auth/middleware.js`
   - Timing-safe comparison via double-SHA256
   - Built-in token-bucket rate limiting
2. **Gateway auth**: Bearer token with multi-source resolution via `src/gateway/token.js`
   - Resolution order: env var → persisted file → generate new
   - Token injection via `http-proxy` event handlers (`proxyReq` and `proxyReqWs`)

### Smart Router

The smart router (`src/smart-router/`) optimizes AI model costs by routing tasks to the cheapest capable model:

1. **Classify** — weighted keyword scoring determines ROUTINE vs IMPORTANT, with complexity levels (low → very_high)
2. **Route** — selects model based on classification, complexity, image needs, and available API keys
3. **Execute** — calls model through circuit-breaker-wrapped executor (free or paid)
4. **Log** — async JSONL logging with Prometheus metrics and budget alerts

**Model tiers:**
- **Free (NVIDIA direct):** nemotron-nano-9b, 12b-vl, 30b, super-120b, ultra-253b, deepseek-r1
- **Free (OpenRouter):** same models via OpenRouter
- **Paid:** claude-3-5-sonnet, claude-3-opus, gpt-4o

### Onboarding Process

When the user runs setup:

1. Calls `openclaw onboard --non-interactive` with user-selected auth provider
2. Syncs wrapper token to `openclaw.json` (overwrites onboard-generated token)
3. Writes channel configs via `openclaw config set --json`
4. Force-sets gateway config (token auth, loopback bind, allowInsecureAuth)
5. Restarts gateway and waits for readiness

### Backup Export/Import

- `GET /setup/export` — creates `.tar.gz` of STATE_DIR and WORKSPACE_DIR
- `POST /setup/import` — imports `.tar.gz` with path traversal prevention, 250MB limit

## Common Development Tasks

### Running tests

```bash
npm test                    # All 151 tests
npm run test:lib            # Library module tests only
npm run test:router         # Smart-router tests only
```

Tests are self-contained with no external dependencies. They use temp directories and clean up after themselves.

### Testing the setup wizard

1. Delete `${STATE_DIR}/openclaw.json` (or run Reset in the UI)
2. Visit `/setup` and complete onboarding
3. Check structured JSON logs for gateway startup

### Debugging gateway startup

Check structured JSON logs for:
- `{"component":"gateway.lifecycle","msg":"starting gateway",...}`
- `{"component":"gateway.lifecycle","msg":"gateway ready",...}`
- `{"component":"gateway.lifecycle","msg":"gateway exited",...}`

If gateway doesn't start:
- Verify `openclaw.json` exists and is valid JSON
- Check `STATE_DIR` and `WORKSPACE_DIR` are writable
- Check `/healthz` endpoint for status
- Check `/metrics` for Prometheus data
- Ensure bearer token is set in config

### Adding a new library module

1. Create `src/lib/your-module.js`
2. Add tests in `src/lib/test.js`
3. Import in `src/server.js` as needed
4. Run `npm test` to verify

### Adding a new alert type

1. Add to `AlertType` enum in `src/lib/alerts.js`
2. Add severity mapping in `SEVERITY` object
3. Call `alerts.alert(AlertType.YOUR_TYPE, message, data)` where needed

## Railway Deployment Notes

- Template must mount a volume at `/data`
- Must set `SETUP_PASSWORD` in Railway Variables
- Public networking must be enabled (assigns `*.up.railway.app` domain)
- Openclaw version is **auto-detected** at build time (latest stable release); set `OPENCLAW_VERSION` only to pin a specific tag/branch
- Set `ALERT_WEBHOOK_URL` for Slack/Discord notifications on failures

## Quirks & Gotchas

1. **Gateway token must be stable across redeploys** → Always set `OPENCLAW_GATEWAY_TOKEN` env variable in Railway. Token is synced to `openclaw.json` on every gateway start via `src/gateway/lifecycle.js`.
2. **Channels are written via `config set --json`, not `channels add`** → avoids CLI version incompatibilities
3. **Gateway readiness polls multiple endpoints** (`/openclaw`, `/`, `/health`) → some builds only expose certain routes
4. **Discord bots require MESSAGE CONTENT INTENT** → document this in setup wizard
5. **WebSocket auth requires proxy event handlers** → Direct `req.headers` modification doesn't work for WebSocket upgrades; `src/gateway/proxy.js` uses `proxyReqWs` event
6. **Control UI requires allowInsecureAuth** → Set during onboarding to prevent pairing errors
7. **Debug logging must check DEBUG flag** → Structured logger respects `LOG_LEVEL` and `OPENCLAW_TEMPLATE_DEBUG` env vars
8. **Credentials directory permissions** → Must be 700 (owner-only), not 755
9. **Import requires /data paths** → `OPENCLAW_STATE_DIR` and `OPENCLAW_WORKSPACE_DIR` must be under `/data` for Railway volume security
10. **CostTracker writes are async** → Use a small delay before reading back JSONL files in tests (see `src/smart-router/test.js`)
11. **Circuit breakers have per-provider state** → Each API provider (OpenRouter, NVIDIA, Anthropic, OpenAI) has its own breaker in `src/smart-router/executors.js`
