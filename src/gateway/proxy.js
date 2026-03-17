// Reverse proxy — forwards HTTP and WebSocket traffic to the internal gateway.
// Injects Authorization header server-side so clients don't need the token.

import fs from "node:fs";
import path from "node:path";
import httpProxy from "http-proxy";
import { createLogger } from "../lib/logger.js";

const log = createLogger("proxy");

/**
 * Create and configure the reverse proxy.
 * @param {object} opts
 * @param {string} opts.target - Gateway URL (e.g., "http://127.0.0.1:18789")
 * @param {string} opts.gatewayToken - Bearer token to inject
 * @returns {import("http-proxy").Server}
 */
export function createProxy(opts) {
  const { target, gatewayToken } = opts;

  const proxy = httpProxy.createProxyServer({
    target,
    ws: true,
    xfwd: true,
    proxyTimeout: 120_000,
    timeout: 120_000,
    changeOrigin: true,
  });

  // Determine the Origin header value
  const proxyOrigin = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : target;

  // Inject auth + origin for HTTP requests
  proxy.on("proxyReq", (proxyReq) => {
    proxyReq.setHeader("Authorization", `Bearer ${gatewayToken}`);
    proxyReq.setHeader("Origin", proxyOrigin);
  });

  // Inject auth + origin for WebSocket upgrades
  proxy.on("proxyReqWs", (proxyReq) => {
    proxyReq.setHeader("Authorization", `Bearer ${gatewayToken}`);
    proxyReq.setHeader("Origin", proxyOrigin);
  });

  // Error handler — show loading page instead of crashing
  proxy.on("error", (err, _req, res) => {
    log.error("proxy error", { error: err.message, code: err.code });
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

  return proxy;
}
