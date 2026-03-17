// Process execution with proper timeout, SIGTERM→SIGKILL escalation,
// output capture, and structured logging.

import childProcess from "node:child_process";
import { createLogger } from "./logger.js";

const log = createLogger("run-cmd");

const DEFAULT_TIMEOUT_MS = 120_000;
const KILL_GRACE_MS = 5_000;

/**
 * Execute a command with proper timeout and signal escalation.
 *
 * @param {string} cmd - Command to run
 * @param {string[]} args - Arguments
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=120000] - Timeout in milliseconds
 * @param {object} [opts.env] - Additional environment variables
 * @param {string} [opts.cwd] - Working directory
 * @param {number} [opts.maxOutputBytes=5242880] - Max output buffer (5MB)
 * @param {AbortSignal} [opts.signal] - External abort signal
 * @returns {Promise<{code: number, output: string, timedOut: boolean, signal: string|null}>}
 */
export async function runCmd(cmd, args, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = opts.maxOutputBytes ?? 5 * 1024 * 1024;

  return new Promise((resolve) => {
    let out = "";
    let outBytes = 0;
    let timedOut = false;
    let killedSignal = null;
    let settled = false;

    const env = {
      ...process.env,
      ...(opts.env || {}),
    };

    const proc = childProcess.spawn(cmd, args, {
      env,
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    function onData(chunk) {
      const str = chunk.toString("utf8");
      if (outBytes < maxOutputBytes) {
        out += str;
        outBytes += chunk.length;
      }
    }

    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);

    // Timeout: SIGTERM first, then SIGKILL after grace period
    const timer = setTimeout(() => {
      timedOut = true;
      log.warn("process timeout, sending SIGTERM", { cmd, timeoutMs });
      try {
        proc.kill("SIGTERM");
      } catch {}
      setTimeout(() => {
        if (!settled) {
          log.warn("process did not exit after SIGTERM, sending SIGKILL", { cmd });
          try {
            proc.kill("SIGKILL");
          } catch {}
        }
      }, KILL_GRACE_MS);
    }, timeoutMs);

    // External abort signal
    if (opts.signal) {
      const onAbort = () => {
        if (!settled) {
          log.info("external abort received", { cmd });
          try { proc.kill("SIGTERM"); } catch {}
        }
      };
      opts.signal.addEventListener("abort", onAbort, { once: true });
      proc.on("close", () => opts.signal.removeEventListener("abort", onAbort));
    }

    proc.on("error", (err) => {
      clearTimeout(timer);
      settled = true;
      out += `\n[spawn error] ${String(err)}\n`;
      resolve({ code: 127, output: out, timedOut: false, signal: null });
    });

    proc.on("close", (code, signal) => {
      clearTimeout(timer);
      settled = true;
      killedSignal = signal;
      resolve({
        code: timedOut ? 124 : (code ?? 0),
        output: out,
        timedOut,
        signal: killedSignal,
      });
    });
  });
}

/**
 * Execute a command and throw if it fails.
 */
export async function runCmdOrThrow(cmd, args, opts = {}) {
  const result = await runCmd(cmd, args, opts);
  if (result.code !== 0) {
    const err = new Error(`Command failed (exit=${result.code}): ${cmd} ${args.slice(0, 3).join(" ")}...`);
    err.code = result.code;
    err.output = result.output;
    err.timedOut = result.timedOut;
    throw err;
  }
  return result;
}
