#!/usr/bin/env node
// Smart Router Test Suite — validates classification, routing, cost tracking,
// and auto-scaling logic without making real API calls.

import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Set a temp log dir so tests don't need /data
const tmpLogDir = path.join(os.tmpdir(), `smart-router-test-${Date.now()}`);
fs.mkdirSync(tmpLogDir, { recursive: true });
process.env.SMART_ROUTER_LOG_DIR = tmpLogDir;

import { TaskClassifier } from "./task-classifier.js";
import { ModelRouter } from "./model-router.js";
import { CostTracker } from "./cost-tracker.js";
import { AutoScaler } from "./auto-scaler.js";
import { SmartRouter } from "./index.js";

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

// ─── TaskClassifier Tests ────────────────────────────────────────────

console.log("\n▸ TaskClassifier");

const classifier = new TaskClassifier();

// Routine tasks
{
  const r = classifier.classify({ description: "Summarize this email thread" });
  assert(r.classification === "ROUTINE", "email summary → ROUTINE");
}
{
  const r = classifier.classify({ description: "Convert this CSV to JSON format" });
  assert(r.classification === "ROUTINE", "CSV to JSON → ROUTINE");
}
{
  const r = classifier.classify({ description: "Extract metadata tags from this document" });
  assert(r.classification === "ROUTINE", "metadata extraction → ROUTINE");
}
{
  const r = classifier.classify({ description: "Translate this paragraph to Spanish" });
  assert(r.classification === "ROUTINE", "basic translation → ROUTINE");
}
{
  const r = classifier.classify({ description: "Format this data as a status report" });
  assert(r.classification === "ROUTINE", "status report formatting → ROUTINE");
}

// Important tasks
{
  const r = classifier.classify({ description: "Design the system architecture for our new microservice" });
  assert(r.classification === "IMPORTANT", "architecture design → IMPORTANT");
}
{
  const r = classifier.classify({ description: "Debug this complex memory leak and analyze root cause" });
  assert(r.classification === "IMPORTANT", "complex debugging → IMPORTANT");
}
{
  const r = classifier.classify({ description: "Review and optimize this critical code path" });
  assert(r.classification === "IMPORTANT", "code review + optimize → IMPORTANT");
}
{
  const r = classifier.classify({ description: "Develop a strategy for our Q3 product roadmap" });
  assert(r.classification === "IMPORTANT", "strategy planning → IMPORTANT");
}
{
  const r = classifier.classify({ description: "Security audit of our authentication system" });
  assert(r.classification === "IMPORTANT", "security audit → IMPORTANT");
}

// Priority override
{
  const r = classifier.classify({ description: "Summarize this email", priority: "high" });
  assert(r.classification === "IMPORTANT", "priority=high overrides to IMPORTANT");
}
{
  const r = classifier.classify({ description: "Design architecture", priority: "low" });
  assert(r.classification === "ROUTINE", "priority=low overrides to ROUTINE");
}

// Token estimation
{
  const r = classifier.classify({ content: "x".repeat(4000) });
  assert(r.inputTokens === 1000, "4000 chars → ~1000 tokens");
}

// Image detection
{
  const r = classifier.classify({ description: "Analyze this", hasImage: true });
  assert(r.hasImage === true, "hasImage propagated");
  assert(r.capabilities.includes("vision"), "vision capability added for images");
}

// ─── ModelRouter Tests ───────────────────────────────────────────────

console.log("\n▸ ModelRouter");

const router = new ModelRouter();

// Routine routing
{
  const sel = router.select({ classification: "ROUTINE", inputTokens: 500, hasImage: false, complexity: "low" });
  assert(sel.modelKey === "nemotron-nano-9b", "small routine → nano-9b");
  assert(sel.type === "FREE", "routine → FREE type");
}
{
  const sel = router.select({ classification: "ROUTINE", inputTokens: 1500, hasImage: false, complexity: "low" });
  assert(sel.modelKey === "nemotron-nano-9b", "1500 tokens low complexity → nano-9b");
}
{
  const sel = router.select({ classification: "ROUTINE", inputTokens: 500, hasImage: true, complexity: "low" });
  assert(sel.modelKey === "nemotron-nano-12b-vl", "image → nano-12b-vl");
}
{
  const sel = router.select({ classification: "ROUTINE", inputTokens: 5000, hasImage: false, complexity: "medium_high" });
  assert(sel.modelKey === "nemotron-super-120b", "large routine → super-120b");
}

// Important routing
{
  const sel = router.select({ classification: "IMPORTANT", inputTokens: 2000, hasImage: false, complexity: "high" });
  assert(sel.modelKey === "claude-3-5-sonnet", "important high → sonnet");
  assert(sel.type === "PAID", "important → PAID type");
}
{
  const sel = router.select({ classification: "IMPORTANT", inputTokens: 2000, hasImage: false, complexity: "very_high" });
  assert(sel.modelKey === "claude-3-opus", "very_high → opus");
}
{
  const sel = router.select({ classification: "IMPORTANT", inputTokens: 2000, hasImage: true, complexity: "very_high" });
  assert(sel.modelKey === "gpt-4o", "very_high + image → gpt-4o");
}

// Fallback chain
{
  const fb = router.getFallback("nemotron-nano-9b", { classification: "ROUTINE" });
  assert(fb && fb.modelKey === "nemotron-nano-30b", "nano-9b fallback → nano-30b");
}
{
  const fb = router.getFallback("nemotron-super-120b", { classification: "ROUTINE" });
  assert(fb && fb.modelKey === "claude-3-5-sonnet", "super-120b fallback → paid sonnet");
}
{
  const fb = router.getFallback("claude-3-5-sonnet", { classification: "IMPORTANT" });
  assert(fb && fb.modelKey === "claude-3-opus", "sonnet fallback → opus");
}

// Model disabling
{
  const r2 = new ModelRouter();
  r2.disableModel("nemotron-nano-9b", 100);
  const sel = r2.select({ classification: "ROUTINE", inputTokens: 500, hasImage: false, complexity: "low" });
  assert(sel.modelKey !== "nemotron-nano-9b", "disabled model skipped");
}

// ─── NVIDIA Direct API Tests (simulated) ────────────────────────────

console.log("\n▸ ModelRouter (NVIDIA direct)");

// Simulate NVIDIA_API_KEY being set
process.env.NVIDIA_API_KEY = "test-nvidia-key";
// Force config to pick it up (config reads env at access time for nvidiaApiKey)
{
  const { ModelRouter: MR } = await import("./model-router.js");
  const nRouter = new MR();

  assert(nRouter.hasNvidiaDirect === true, "detects NVIDIA_API_KEY");

  // Low-complexity routine → fast small free model (not NVIDIA direct)
  const selLow = nRouter.select({ classification: "ROUTINE", inputTokens: 500, hasImage: false, complexity: "low" });
  assert(selLow.modelKey === "nemotron-nano-9b", "low complexity routine → nano-9b (fast)");
  assert(selLow.type === "FREE", "NVIDIA present, low routine → FREE type");

  // Medium complexity routine → NVIDIA direct (better quality)
  const sel = nRouter.select({ classification: "ROUTINE", inputTokens: 2000, hasImage: false, complexity: "medium" });
  assert(sel.useNvidiaDirect === true, "medium routine routes to NVIDIA direct");
  assert(sel.type === "FREE", "NVIDIA direct is FREE type");

  // Important high → NVIDIA direct (nemotron ultra or deepseek)
  const sel2 = nRouter.select({ classification: "IMPORTANT", inputTokens: 2000, hasImage: false, complexity: "high" });
  assert(sel2.useNvidiaDirect === true, "important high → NVIDIA direct");
  assert(sel2.modelKey === "nvidia-nemotron-ultra-253b", "high complexity → ultra-253b");

  // Very high → DeepSeek R1
  const sel3 = nRouter.select({ classification: "IMPORTANT", inputTokens: 2000, hasImage: false, complexity: "very_high" });
  assert(sel3.modelKey === "nvidia-deepseek-r1", "very_high → deepseek-r1");

  // Fallback from NVIDIA direct → paid
  nRouter.disableModel("nvidia-deepseek-r1", 100);
  const fb = nRouter.getFallback("nvidia-deepseek-r1", { classification: "IMPORTANT" });
  assert(fb !== null, "NVIDIA fallback exists");
}
// Clean up
delete process.env.NVIDIA_API_KEY;

// ─── CostTracker Tests ──────────────────────────────────────────────

console.log("\n▸ CostTracker");

const tracker = new CostTracker();

{
  const entry = tracker.log({
    description: "test task",
    classification: "ROUTINE",
    selectedModel: "nemotron-nano-9b",
    modelType: "FREE",
    inputTokens: 100,
    outputTokens: 50,
    cost: 0,
    latencyMs: 1500,
    success: true,
  });
  assert(entry.task_id && entry.task_id.length > 0, "log entry has task_id");
  assert(entry.total_cost === 0, "free model cost = 0");
  assert(entry.success === true, "success logged");
}

{
  // Log a paid task
  tracker.log({
    description: "important task",
    classification: "IMPORTANT",
    selectedModel: "claude-3-5-sonnet",
    modelType: "PAID",
    inputTokens: 1000,
    outputTokens: 500,
    cost: 0.003,
    latencyMs: 3000,
    success: true,
  });

  // Wait for async flush to complete before reading back
  await new Promise((r) => setTimeout(r, 100));

  const summary = tracker.dailySummary();
  assert(summary.totalTasks >= 2, "summary counts tasks");
  assert(summary.freeModelTasks >= 1, "summary counts free tasks");
  assert(summary.paidModelTasks >= 1, "summary counts paid tasks");
  assert(summary.costEfficiencyRatio > 0, "efficiency ratio > 0");
}

// ─── AutoScaler Tests ───────────────────────────────────────────────

console.log("\n▸ AutoScaler");

{
  const r3 = new ModelRouter();
  const scaler = new AutoScaler(r3);

  // Record successes
  for (let i = 0; i < 10; i++) scaler.recordSuccess("nemotron-nano-9b");

  const stats = scaler.getStats();
  assert(stats["nemotron-nano-9b"].total === 10, "tracks total executions");
  assert(stats["nemotron-nano-9b"].errors === 0, "no errors recorded");
}

{
  const r4 = new ModelRouter();
  const scaler = new AutoScaler(r4);

  // Simulate high error rate (>5% with sufficient samples)
  for (let i = 0; i < 4; i++) scaler.recordSuccess("nemotron-nano-9b");
  const fb = scaler.recordFailureAndGetFallback("nemotron-nano-9b", { classification: "ROUTINE" });
  assert(fb !== null, "fallback returned on failure");
  assert(fb.modelKey === "nemotron-nano-30b", "falls back to next model");
}

// ─── SmartRouter classifyOnly Tests ─────────────────────────────────

console.log("\n▸ SmartRouter.classifyOnly");

const sr = new SmartRouter();

{
  const result = sr.classifyOnly({ description: "Summarize this meeting transcript" });
  assert(result.classification.classification === "ROUTINE", "classifyOnly: routine task");
  assert(result.selectedModel.type === "FREE", "classifyOnly: routes to free");
}
{
  const result = sr.classifyOnly({ description: "Architect a distributed caching system" });
  assert(result.classification.classification === "IMPORTANT", "classifyOnly: important task");
  assert(result.selectedModel.type === "PAID", "classifyOnly: routes to paid");
}

// ─── Status Check ───────────────────────────────────────────────────

console.log("\n▸ SmartRouter.getStatus");

{
  const status = sr.getStatus();
  assert(typeof status.openrouterConfigured === "boolean", "status: openrouter check");
  assert(typeof status.dailyBudget === "number", "status: budget check");
  assert(status.logDir.length > 0, "status: logDir set");
}

// ─── Summary ────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log("All tests passed!\n");
}
