// Gateway token resolution — resolves, persists, and syncs the bearer token.
// Token must be stable across restarts to avoid breaking active sessions.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createLogger } from "../lib/logger.js";

const log = createLogger("gateway.token");

/**
 * Resolve the gateway token from env → file → generate.
 * @param {string} stateDir - Path to state directory
 * @returns {string} The gateway token
 */
export function resolveGatewayToken(stateDir) {
  // 1. Environment variable (highest priority, always wins)
  const envTok = process.env.OPENCLAW_GATEWAY_TOKEN?.trim();
  if (envTok) {
    log.info("using token from OPENCLAW_GATEWAY_TOKEN env var");
    return envTok;
  }

  // 2. Persisted file
  const tokenPath = path.join(stateDir, "gateway.token");
  try {
    const existing = fs.readFileSync(tokenPath, "utf8").trim();
    if (existing) {
      log.info("using persisted token from gateway.token file");
      return existing;
    }
  } catch (err) {
    log.debug("no persisted token found", { error: err.code || err.message });
  }

  // 3. Generate and persist
  const generated = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(tokenPath, generated, { encoding: "utf8", mode: 0o600 });
    log.info("generated and persisted new gateway token");
  } catch (err) {
    log.warn("could not persist generated token", { error: err.code || err.message });
  }

  return generated;
}
