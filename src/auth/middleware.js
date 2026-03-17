// Authentication middleware — Basic auth for /setup routes,
// timing-safe comparison, rate limiting.

import crypto from "node:crypto";
import { TokenBucketLimiter } from "../lib/rate-limiter.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("auth");

/**
 * Create the setup auth middleware.
 * @param {string|undefined} setupPassword - The SETUP_PASSWORD
 * @returns {Function} Express middleware
 */
export function createSetupAuth(setupPassword) {
  // Rate limiter: 50 requests per minute per IP
  const limiter = new TokenBucketLimiter({
    maxTokens: 50,
    refillRate: 50 / 60, // 50 per 60s
  });

  return (req, res, next) => {
    if (!setupPassword) {
      return res
        .status(500)
        .type("text/plain")
        .send("SETUP_PASSWORD is not set. Set it in Railway Variables before using /setup.");
    }

    const ip = req.ip || req.socket?.remoteAddress || "unknown";
    if (!limiter.consume(ip)) {
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

    if (!timingSafeCompare(password, setupPassword)) {
      log.warn("failed auth attempt", { ip });
      res.set("WWW-Authenticate", 'Basic realm="OpenClaw Setup"');
      return res.status(401).send("Invalid password");
    }

    return next();
  };
}

/**
 * Timing-safe string comparison via double-hashing.
 */
function timingSafeCompare(a, b) {
  const hashA = crypto.createHash("sha256").update(a).digest();
  const hashB = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

/**
 * Verify TUI auth from Basic header or WebSocket subprotocol.
 * @param {object} req - HTTP request
 * @param {string} setupPassword
 * @returns {boolean}
 */
export function verifyTuiAuth(req, setupPassword) {
  if (!setupPassword) return false;

  // Check Authorization header
  const authHeader = req.headers["authorization"] || "";
  if (authHeader.startsWith("Basic ")) {
    const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf8");
    const password = decoded.includes(":") ? decoded.split(":").slice(1).join(":") : decoded;
    if (timingSafeCompare(password, setupPassword)) return true;
  }

  // Check WebSocket subprotocol (browsers can't set custom headers on WS)
  const protocols = (req.headers["sec-websocket-protocol"] || "").split(",").map((s) => s.trim());
  for (const proto of protocols) {
    if (proto.startsWith("auth-")) {
      try {
        const decoded = Buffer.from(proto.slice(5), "base64").toString("utf8");
        const password = decoded.includes(":") ? decoded.split(":").slice(1).join(":") : decoded;
        if (timingSafeCompare(password, setupPassword)) return true;
      } catch { /* invalid base64 */ }
    }
  }

  return false;
}
