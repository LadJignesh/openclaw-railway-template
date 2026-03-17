#!/usr/bin/env node
// Comprehensive test suite for all library modules.
// Run: node src/lib/test.js

import os from "node:os";
import path from "node:path";
import fs from "node:fs";

let passed = 0;
let failed = 0;

function assert(condition, name) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}`);
  }
}

async function assertThrows(fn, name) {
  try {
    await fn();
    failed++;
    console.error(`  ✗ ${name} (did not throw)`);
  } catch {
    passed++;
    console.log(`  ✓ ${name}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Circuit Breaker
// ═══════════════════════════════════════════════════════════════════════

console.log("\n▸ CircuitBreaker");

import { CircuitBreaker, CircuitOpenError, State } from "./circuit-breaker.js";

{
  const cb = new CircuitBreaker({ name: "test-ok", failureThreshold: 3, windowMs: 60000 });
  const result = await cb.exec(() => Promise.resolve("hello"));
  assert(result === "hello", "passes through successful calls");
  assert(cb.state === State.CLOSED, "stays CLOSED on success");
  assert(cb.stats.success === 1, "tracks success count");
}

{
  const cb = new CircuitBreaker({ name: "test-fail", failureThreshold: 3, windowMs: 60000 });
  for (let i = 0; i < 3; i++) {
    try { await cb.exec(() => Promise.reject(new Error("boom"))); } catch {}
  }
  assert(cb.state === State.OPEN, "opens after failureThreshold failures");
  assert(cb.stats.failure === 3, "tracks failure count");
}

{
  const cb = new CircuitBreaker({ name: "test-open", failureThreshold: 2, windowMs: 60000 });
  try { await cb.exec(() => Promise.reject(new Error("a"))); } catch {}
  try { await cb.exec(() => Promise.reject(new Error("b"))); } catch {}
  assert(cb.state === State.OPEN, "is OPEN");

  try {
    await cb.exec(() => Promise.resolve("should not run"));
    assert(false, "should have thrown CircuitOpenError");
  } catch (err) {
    assert(err instanceof CircuitOpenError, "throws CircuitOpenError when OPEN");
    assert(err.name === "CircuitOpenError", "error has correct name property");
  }
  assert(cb.stats.rejected === 1, "tracks rejected count");
}

{
  const cb = new CircuitBreaker({
    name: "test-half-open",
    failureThreshold: 2,
    resetTimeoutMs: 50, // very short for testing
    successThreshold: 2,
    halfOpenMax: 3,
    windowMs: 60000,
  });
  try { await cb.exec(() => Promise.reject(new Error("a"))); } catch {}
  try { await cb.exec(() => Promise.reject(new Error("b"))); } catch {}
  assert(cb.state === State.OPEN, "opens after failures");

  // Wait for resetTimeout
  await new Promise((r) => setTimeout(r, 60));

  const r1 = await cb.exec(() => Promise.resolve("ok1"));
  assert(cb.state === State.HALF_OPEN, "transitions to HALF_OPEN after timeout");
  assert(r1 === "ok1", "allows requests in HALF_OPEN");

  const r2 = await cb.exec(() => Promise.resolve("ok2"));
  assert(cb.state === State.CLOSED, "closes after successThreshold successes");
}

{
  const cb = new CircuitBreaker({
    name: "test-half-open-fail",
    failureThreshold: 2,
    resetTimeoutMs: 50,
    halfOpenMax: 2,
    windowMs: 60000,
  });
  try { await cb.exec(() => Promise.reject(new Error("a"))); } catch {}
  try { await cb.exec(() => Promise.reject(new Error("b"))); } catch {}
  await new Promise((r) => setTimeout(r, 60));

  try { await cb.exec(() => Promise.reject(new Error("still bad"))); } catch {}
  assert(cb.state === State.OPEN, "re-opens on failure in HALF_OPEN");
}

{
  const cb = new CircuitBreaker({ name: "test-reset", failureThreshold: 2, windowMs: 60000 });
  try { await cb.exec(() => Promise.reject(new Error("a"))); } catch {}
  try { await cb.exec(() => Promise.reject(new Error("b"))); } catch {}
  assert(cb.state === State.OPEN, "is OPEN before reset");
  cb.reset();
  assert(cb.state === State.CLOSED, "reset() returns to CLOSED");
}

{
  const cb = new CircuitBreaker({ name: "test-status" });
  const status = cb.getStatus();
  assert(status.name === "test-status", "getStatus returns name");
  assert(status.state === State.CLOSED, "getStatus returns state");
  assert(typeof status.stats === "object", "getStatus returns stats");
}

{
  // Window-based pruning: old failures should expire
  const cb = new CircuitBreaker({
    name: "test-window",
    failureThreshold: 3,
    windowMs: 100,
  });
  try { await cb.exec(() => Promise.reject(new Error("a"))); } catch {}
  try { await cb.exec(() => Promise.reject(new Error("b"))); } catch {}
  assert(cb.state === State.CLOSED, "still closed with 2 failures");

  await new Promise((r) => setTimeout(r, 120)); // Wait for window to expire

  try { await cb.exec(() => Promise.reject(new Error("c"))); } catch {}
  assert(cb.state === State.CLOSED, "old failures pruned, stays CLOSED");
}

// ═══════════════════════════════════════════════════════════════════════
// Token Bucket Rate Limiter
// ═══════════════════════════════════════════════════════════════════════

console.log("\n▸ TokenBucketLimiter");

import { TokenBucketLimiter } from "./rate-limiter.js";

{
  const limiter = new TokenBucketLimiter({ maxTokens: 3, refillRate: 1, cleanupIntervalMs: 60000 });

  assert(limiter.consume("ip1") === true, "first request allowed");
  assert(limiter.consume("ip1") === true, "second request allowed");
  assert(limiter.consume("ip1") === true, "third request allowed (bucket=3)");
  assert(limiter.consume("ip1") === false, "fourth request denied (bucket empty)");

  limiter.destroy();
}

{
  const limiter = new TokenBucketLimiter({ maxTokens: 2, refillRate: 100, cleanupIntervalMs: 60000 });

  limiter.consume("ip1");
  limiter.consume("ip1");
  assert(limiter.consume("ip1") === false, "bucket empty initially");

  // Wait for refill (100 tokens/sec → 10ms = 1 token)
  await new Promise((r) => setTimeout(r, 20));
  assert(limiter.consume("ip1") === true, "bucket refilled after wait");

  limiter.destroy();
}

{
  const limiter = new TokenBucketLimiter({ maxTokens: 5, refillRate: 1, cleanupIntervalMs: 60000 });

  assert(limiter.remaining("new-ip") === 5, "remaining returns max for unknown key");
  limiter.consume("new-ip");
  const rem = limiter.remaining("new-ip");
  assert(rem >= 3 && rem <= 4.1, "remaining decreases after consume");

  limiter.destroy();
}

{
  // Separate buckets per key
  const limiter = new TokenBucketLimiter({ maxTokens: 1, refillRate: 0.001, cleanupIntervalMs: 60000 });

  assert(limiter.consume("ip-a") === true, "ip-a first request ok");
  assert(limiter.consume("ip-b") === true, "ip-b first request ok (separate bucket)");
  assert(limiter.consume("ip-a") === false, "ip-a second request denied");
  assert(limiter.consume("ip-b") === false, "ip-b second request denied");

  limiter.destroy();
}

// ═══════════════════════════════════════════════════════════════════════
// Secret Redaction
// ═══════════════════════════════════════════════════════════════════════

console.log("\n▸ redactSecrets");

import { redactSecrets, setGatewayToken } from "./redact.js";

{
  const text = "key is sk-proj-abc1234567890xyz";
  const redacted = redactSecrets(text);
  assert(!redacted.includes("abc1234567890"), "redacts OpenAI sk-proj keys");
  assert(redacted.includes("[REDACTED]"), "replaces with [REDACTED]");
}

{
  const text = "anthropic: sk-ant-abcdefghij1234567890";
  assert(!redactSecrets(text).includes("abcdefghij"), "redacts Anthropic keys");
}

{
  const text = "github: ghp_abcdefghij1234";
  assert(!redactSecrets(text).includes("abcdefghij"), "redacts GitHub tokens");
}

{
  const text = "nvidia key: nvapi-abcdefghij12345";
  assert(!redactSecrets(text).includes("abcdefghij"), "redacts NVIDIA keys");
}

{
  const text = "slack: xoxb-abcdefghij1234567890";
  assert(!redactSecrets(text).includes("abcdefghij"), "redacts Slack tokens");
}

{
  const text = "telegram: 123456:ABCDefghij1234567890";
  assert(!redactSecrets(text).includes("ABCDefghij"), "redacts Telegram tokens");
}

{
  const text = "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0";
  const redacted = redactSecrets(text);
  assert(redacted.includes("Bearer "), "preserves Bearer prefix");
  assert(redacted.includes("[REDACTED]"), "redacts Bearer token value");
}

{
  const text = "openrouter: sk-or-v1-abcdefghij1234567890";
  assert(!redactSecrets(text).includes("abcdefghij"), "redacts OpenRouter keys");
}

{
  setGatewayToken("my-secret-gateway-token-1234");
  const text = "token is my-secret-gateway-token-1234 end";
  const redacted = redactSecrets(text);
  assert(!redacted.includes("my-secret-gateway-token-1234"), "redacts gateway token");
  setGatewayToken(""); // cleanup
}

{
  assert(redactSecrets("") === "", "handles empty string");
  assert(redactSecrets(null) === null, "handles null");
  assert(redactSecrets(undefined) === undefined, "handles undefined");
}

{
  const clean = "This is a normal log message with no secrets";
  assert(redactSecrets(clean) === clean, "leaves clean text unchanged");
}

// ═══════════════════════════════════════════════════════════════════════
// Run Command
// ═══════════════════════════════════════════════════════════════════════

console.log("\n▸ runCmd");

import { runCmd, runCmdOrThrow } from "./run-cmd.js";

{
  const result = await runCmd("echo", ["hello world"]);
  assert(result.code === 0, "echo exits with 0");
  assert(result.output.trim() === "hello world", "captures stdout");
  assert(result.timedOut === false, "not timed out");
  assert(result.signal === null, "no signal");
}

{
  const result = await runCmd("node", ["-e", "process.exit(42)"]);
  assert(result.code === 42, "captures non-zero exit code");
}

{
  const result = await runCmd("node", ["-e", "console.error('err msg'); process.exit(1)"]);
  assert(result.code === 1, "captures stderr exit code");
  assert(result.output.includes("err msg"), "captures stderr output");
}

{
  const result = await runCmd("sleep", ["10"], { timeoutMs: 200 });
  assert(result.timedOut === true, "detects timeout");
  assert(result.code === 124, "returns 124 on timeout");
}

{
  const result = await runCmd("nonexistent-command-xyz", []);
  assert(result.code === 127, "returns 127 for spawn error");
  assert(result.output.includes("spawn error"), "includes spawn error message");
}

{
  const result = await runCmdOrThrow("echo", ["ok"]);
  assert(result.output.trim() === "ok", "runCmdOrThrow returns result on success");
}

{
  await assertThrows(
    () => runCmdOrThrow("node", ["-e", "process.exit(1)"]),
    "runCmdOrThrow throws on non-zero exit"
  );
}

{
  const controller = new AbortController();
  const promise = runCmd("sleep", ["10"], { signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  const result = await promise;
  assert(result.code !== 0 || result.signal !== null, "abort signal stops process");
}

// ═══════════════════════════════════════════════════════════════════════
// Metrics
// ═══════════════════════════════════════════════════════════════════════

console.log("\n▸ Metrics");

import { registry as testRegistry } from "./metrics.js";

{
  const counter = testRegistry.counter("test_counter", "A test counter", ["method"]);
  counter.inc({ method: "GET" });
  counter.inc({ method: "GET" });
  counter.inc({ method: "POST" });

  const serialized = counter.serialize();
  assert(serialized.includes("# TYPE test_counter counter"), "counter has TYPE line");
  assert(serialized.includes('test_counter{method="GET"} 2'), "counter tracks label values");
  assert(serialized.includes('test_counter{method="POST"} 1'), "counter tracks separate labels");
}

{
  const gauge = testRegistry.gauge("test_gauge", "A test gauge", ["region"]);
  gauge.set({ region: "us" }, 42);
  gauge.set({ region: "eu" }, 17);
  gauge.set({ region: "us" }, 99); // overwrite

  const serialized = gauge.serialize();
  assert(serialized.includes("# TYPE test_gauge gauge"), "gauge has TYPE line");
  assert(serialized.includes('test_gauge{region="us"} 99'), "gauge overwrites on set");
  assert(serialized.includes('test_gauge{region="eu"} 17'), "gauge keeps separate labels");
}

{
  const gauge = testRegistry.gauge("test_gauge_inc", "Incrementing gauge");
  gauge.inc({}, 5);
  gauge.inc({}, 3);
  assert(gauge.values.get("") === 8, "gauge.inc increments value");
}

{
  const hist = testRegistry.histogram("test_hist", "A test histogram", [], [1, 5, 10]);
  hist.observe({}, 0.5);
  hist.observe({}, 3);
  hist.observe({}, 7);
  hist.observe({}, 15);

  const serialized = hist.serialize();
  assert(serialized.includes("# TYPE test_hist histogram"), "histogram has TYPE line");
  assert(serialized.includes('test_hist_bucket{le="1"} 1'), "bucket le=1 has 1 observation");
  assert(serialized.includes('test_hist_bucket{le="5"} 2'), "bucket le=5 has 2 observations");
  assert(serialized.includes('test_hist_bucket{le="10"} 3'), "bucket le=10 has 3 observations");
  assert(serialized.includes('test_hist_bucket{le="+Inf"} 4'), "+Inf bucket has all observations");
  assert(serialized.includes("test_hist_count 4"), "histogram count correct");
}

{
  const output = testRegistry.serialize();
  assert(output.includes("process_uptime_seconds"), "registry includes process uptime");
  assert(output.includes("test_counter"), "registry includes registered metrics");
}

// ═══════════════════════════════════════════════════════════════════════
// Alerts
// ═══════════════════════════════════════════════════════════════════════

console.log("\n▸ Alerts");

import { alerts, AlertType } from "./alerts.js";

{
  await alerts.alert(AlertType.BUDGET_WARNING, "test budget warning", { cost: 5 });
  const history = alerts.getHistory();
  assert(history.length >= 1, "alert added to history");
  const last = history[history.length - 1];
  assert(last.type === AlertType.BUDGET_WARNING, "alert has correct type");
  assert(last.message === "test budget warning", "alert has correct message");
  assert(last.severity === "warning", "budget_warning has warning severity");
}

{
  // Test cooldown: same type should be suppressed
  const before = alerts.getHistory().length;
  await alerts.alert(AlertType.BUDGET_WARNING, "suppressed", {});
  const after = alerts.getHistory().length;
  assert(after === before + 1, "suppressed alert still added to history");
}

{
  await alerts.alert(AlertType.GATEWAY_DOWN, "gateway is down", {});
  const last = alerts.getHistory().slice(-1)[0];
  assert(last.severity === "critical", "gateway_down has critical severity");
}

{
  assert(alerts.isConfigured() === false, "not configured without ALERT_WEBHOOK_URL");
}

// ═══════════════════════════════════════════════════════════════════════
// Logger
// ═══════════════════════════════════════════════════════════════════════

console.log("\n▸ Logger");

import { createLogger, withCorrelation, generateCorrelationId } from "./logger.js";

{
  const logger = createLogger("test-component");
  assert(typeof logger.debug === "function", "logger has debug method");
  assert(typeof logger.info === "function", "logger has info method");
  assert(typeof logger.warn === "function", "logger has warn method");
  assert(typeof logger.error === "function", "logger has error method");
  assert(typeof logger.fatal === "function", "logger has fatal method");
}

{
  const child = createLogger("parent").child("sub");
  assert(typeof child.info === "function", "child logger works");
}

{
  const cid = generateCorrelationId();
  assert(typeof cid === "string", "generates string correlation ID");
  assert(cid.length === 16, "correlation ID is 16 hex chars");
}

{
  let capturedId = null;
  withCorrelation("test-123", () => {
    capturedId = "test-123"; // correlation is set during fn execution
  });
  assert(capturedId === "test-123", "withCorrelation executes function");
}

// ═══════════════════════════════════════════════════════════════════════
// Gateway Token Resolution
// ═══════════════════════════════════════════════════════════════════════

console.log("\n▸ Gateway Token");

import { resolveGatewayToken } from "../gateway/token.js";

{
  // Test env var priority
  const orig = process.env.OPENCLAW_GATEWAY_TOKEN;
  process.env.OPENCLAW_GATEWAY_TOKEN = "test-env-token";
  const token = resolveGatewayToken("/tmp/nonexistent");
  assert(token === "test-env-token", "env var takes priority");
  if (orig) process.env.OPENCLAW_GATEWAY_TOKEN = orig;
  else delete process.env.OPENCLAW_GATEWAY_TOKEN;
}

{
  // Test file persistence
  delete process.env.OPENCLAW_GATEWAY_TOKEN;
  const tmpDir = path.join(os.tmpdir(), `gw-token-test-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(path.join(tmpDir, "gateway.token"), "file-token-xyz", "utf8");

  const token = resolveGatewayToken(tmpDir);
  assert(token === "file-token-xyz", "reads token from file");

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true });
}

{
  // Test generation
  delete process.env.OPENCLAW_GATEWAY_TOKEN;
  const tmpDir = path.join(os.tmpdir(), `gw-token-gen-${Date.now()}`);

  const token = resolveGatewayToken(tmpDir);
  assert(token.length === 64, "generates 64-char hex token");
  assert(/^[a-f0-9]+$/.test(token), "generated token is valid hex");

  // Verify persisted
  const persisted = fs.readFileSync(path.join(tmpDir, "gateway.token"), "utf8").trim();
  assert(persisted === token, "persists generated token to file");

  fs.rmSync(tmpDir, { recursive: true });
}

// ═══════════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════════

console.log(`\n${"─".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log("All tests passed!\n");
}
