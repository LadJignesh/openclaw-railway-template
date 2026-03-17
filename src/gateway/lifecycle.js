// Gateway lifecycle — manages starting, stopping, health checking,
// and auto-restart with exponential backoff.

import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import EventEmitter from "node:events";
import { createLogger } from "../lib/logger.js";
import { runCmd } from "../lib/run-cmd.js";
import { alerts, AlertType } from "../lib/alerts.js";
import * as metrics from "../lib/metrics.js";

const log = createLogger("gateway");

const MAX_RESTARTS = 10;
const BACKOFF_BASE_MS = 2000;
const HEALTH_TIMEOUT_MS = 60_000;
const HEALTH_POLL_MS = 250;
const DOCTOR_COOLDOWN_MS = 300_000; // 5 min

export class GatewayManager extends EventEmitter {
  constructor(opts) {
    super();
    this.stateDir = opts.stateDir;
    this.workspaceDir = opts.workspaceDir;
    this.internalPort = opts.internalPort;
    this.internalHost = opts.internalHost || "127.0.0.1";
    this.gatewayToken = opts.gatewayToken;
    this.openclawNode = opts.openclawNode || "node";
    this.openclawEntry = opts.openclawEntry || "/openclaw/dist/entry.js";

    this.proc = null;
    this.starting = null;
    this.healthy = false;
    this.shuttingDown = false;
    this.restartCount = 0;

    this.lastError = null;
    this.lastExit = null;
    this.lastDoctorOutput = null;
    this.lastDoctorAt = null;
  }

  get target() {
    return `http://${this.internalHost}:${this.internalPort}`;
  }

  get configPath() {
    return process.env.OPENCLAW_CONFIG_PATH?.trim() || path.join(this.stateDir, "openclaw.json");
  }

  get isConfigured() {
    try { return fs.existsSync(this.configPath); } catch { return false; }
  }

  get isReady() {
    return this.proc !== null && this.starting === null;
  }

  get isStarting() {
    return this.starting !== null;
  }

  clawArgs(args) {
    return [this.openclawEntry, ...args];
  }

  async runClaw(args, opts = {}) {
    return runCmd(this.openclawNode, this.clawArgs(args), {
      env: {
        OPENCLAW_STATE_DIR: this.stateDir,
        OPENCLAW_WORKSPACE_DIR: this.workspaceDir,
      },
      ...opts,
    });
  }

  /**
   * Sync the wrapper token to openclaw.json so the gateway recognizes it.
   */
  async syncToken() {
    log.info("syncing token to openclaw.json");
    const result = await this.runClaw(["config", "set", "gateway.auth.token", this.gatewayToken]);
    if (result.code !== 0) {
      log.error("token sync failed", { exit: result.code, output: result.output?.slice(0, 200) });
    }
    return result;
  }

  /**
   * Sync allowed origins for CORS (Railway public domain).
   */
  async syncAllowedOrigins() {
    const publicDomain = process.env.RAILWAY_PUBLIC_DOMAIN;
    if (!publicDomain) return;
    const origin = `https://${publicDomain}`;
    const result = await this.runClaw([
      "config", "set", "--json", "gateway.controlUi.allowedOrigins", JSON.stringify([origin]),
    ]);
    if (result.code === 0) {
      log.info("set allowedOrigins", { origin });
    } else {
      log.warn("failed to set allowedOrigins", { exit: result.code });
    }
  }

  /**
   * Start the gateway process.
   */
  async start() {
    if (this.proc) return;
    if (!this.isConfigured) throw new Error("Gateway cannot start: not configured");

    fs.mkdirSync(this.stateDir, { recursive: true });
    fs.mkdirSync(this.workspaceDir, { recursive: true });

    // Clean stale locks
    for (const lockPath of [
      path.join(this.stateDir, "gateway.lock"),
      "/tmp/openclaw-gateway.lock",
    ]) {
      try { fs.rmSync(lockPath, { force: true }); } catch {}
    }

    // Sync token before start
    await this.syncToken();

    const args = [
      "gateway", "run",
      "--bind", "loopback",
      "--port", String(this.internalPort),
      "--auth", "token",
      "--token", this.gatewayToken,
      "--allow-unconfigured",
    ];

    this.proc = childProcess.spawn(this.openclawNode, this.clawArgs(args), {
      stdio: "inherit",
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: this.stateDir,
        OPENCLAW_WORKSPACE_DIR: this.workspaceDir,
      },
    });

    log.info("gateway process spawned", { pid: this.proc.pid, port: this.internalPort });
    metrics.gatewayRestarts.inc();

    this.proc.on("error", (err) => {
      log.error("spawn error", err);
      this.lastError = String(err);
      this.proc = null;
      this.emit("error", err);
    });

    this.proc.on("exit", (code, signal) => {
      log.warn("gateway exited", { code, signal });
      this.lastExit = { code, signal, at: new Date().toISOString() };
      this.proc = null;
      this.healthy = false;
      metrics.gatewayStatus.set({}, 0);
      this.emit("exit", { code, signal });

      if (!this.shuttingDown && this.isConfigured) {
        this._scheduleRestart();
        this._runDoctor();
      }
    });
  }

  /**
   * Wait for gateway to respond to health checks.
   */
  async waitForReady(timeoutMs = HEALTH_TIMEOUT_MS) {
    const start = Date.now();
    const endpoints = ["/openclaw", "/", "/health"];

    while (Date.now() - start < timeoutMs) {
      for (const endpoint of endpoints) {
        try {
          const res = await fetch(`${this.target}${endpoint}`, { method: "GET" });
          if (res) {
            log.info("gateway ready", { endpoint, startupMs: Date.now() - start });
            this.healthy = true;
            this.restartCount = 0;
            metrics.gatewayStatus.set({}, 1);
            this.emit("ready");
            return true;
          }
        } catch (err) {
          if (err.code !== "ECONNREFUSED" && err.cause?.code !== "ECONNREFUSED") {
            const msg = err.code || err.message;
            if (msg !== "fetch failed" && msg !== "UND_ERR_CONNECT_TIMEOUT") {
              log.debug("health check error", { endpoint, error: msg });
            }
          }
        }
      }
      await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
    }

    log.error("gateway did not become ready", { timeoutMs });
    await alerts.alert(AlertType.GATEWAY_DOWN, `Gateway failed to become ready after ${timeoutMs / 1000}s`);
    return false;
  }

  /**
   * Ensure gateway is running (idempotent — deduplicates concurrent calls).
   */
  async ensureRunning() {
    if (!this.isConfigured) return { ok: false, reason: "not configured" };
    if (this.proc) return { ok: true };

    if (!this.starting) {
      this.starting = (async () => {
        await this.syncAllowedOrigins();
        await this.start();
        const ready = await this.waitForReady();
        if (!ready) throw new Error("Gateway did not become ready in time");
      })().finally(() => {
        this.starting = null;
      });
    }

    await this.starting;
    return { ok: true };
  }

  /**
   * Stop the gateway process.
   */
  async stop() {
    if (!this.proc) return;
    try {
      this.proc.kill("SIGTERM");
    } catch (err) {
      log.warn("kill error", { error: err.message });
    }
    await new Promise((r) => setTimeout(r, 750));
    this.proc = null;
    this.healthy = false;
    metrics.gatewayStatus.set({}, 0);
  }

  /**
   * Restart the gateway.
   */
  async restart() {
    await this.stop();
    return this.ensureRunning();
  }

  /**
   * TCP probe — checks if gateway port is accepting connections.
   */
  async probe() {
    const net = await import("node:net");
    return new Promise((resolve) => {
      const sock = net.createConnection({
        host: this.internalHost,
        port: this.internalPort,
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

  /**
   * Graceful shutdown.
   */
  async shutdown() {
    this.shuttingDown = true;
    if (this.proc) {
      try {
        this.proc.kill("SIGTERM");
        await Promise.race([
          new Promise((resolve) => this.proc?.on("exit", resolve)),
          new Promise((resolve) => setTimeout(resolve, 2000)),
        ]);
        if (this.proc && !this.proc.killed) {
          this.proc.kill("SIGKILL");
        }
      } catch (err) {
        log.warn("error during shutdown kill", { error: err.message });
      }
    }
  }

  /** Get diagnostic status for health endpoints. */
  getStatus() {
    return {
      configured: this.isConfigured,
      running: this.isReady,
      starting: this.isStarting,
      healthy: this.healthy,
      restartCount: this.restartCount,
      lastError: this.lastError,
      lastExit: this.lastExit,
      lastDoctor: this.lastDoctorOutput,
    };
  }

  _scheduleRestart() {
    this.restartCount++;
    if (this.restartCount > MAX_RESTARTS) {
      log.error("exceeded max restarts — stopping auto-restart", { max: MAX_RESTARTS });
      alerts.alert(AlertType.GATEWAY_CRASH_LOOP, `Gateway exceeded ${MAX_RESTARTS} consecutive restarts`);
      return;
    }

    const delayMs = Math.min(BACKOFF_BASE_MS * Math.pow(2, this.restartCount - 1), 60_000);
    log.info("scheduling auto-restart", { delayMs, attempt: this.restartCount, max: MAX_RESTARTS });

    setTimeout(() => {
      if (!this.shuttingDown && !this.proc && this.isConfigured) {
        this.ensureRunning().catch((err) => {
          log.error("auto-restart failed", err);
        });
      }
    }, delayMs);
  }

  async _runDoctor() {
    if (this.lastDoctorAt && Date.now() - this.lastDoctorAt < DOCTOR_COOLDOWN_MS) return;
    this.lastDoctorAt = Date.now();

    try {
      const result = await this.runClaw(["doctor"], { timeoutMs: 30_000 });
      this.lastDoctorOutput = result.output;
      log.info("auto-doctor completed", { exit: result.code });
    } catch (err) {
      log.warn("auto-doctor failed", { error: err.message });
    }
  }
}
