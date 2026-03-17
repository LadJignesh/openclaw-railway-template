// CostTracker — async JSONL logging with log rotation.
// Non-blocking writes to prevent event loop stalls.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import config from "./config.js";
import { createLogger } from "../lib/logger.js";
import { alerts, AlertType } from "../lib/alerts.js";
import * as metrics from "../lib/metrics.js";

const log = createLogger("cost-tracker");

export class CostTracker {
  constructor() {
    this._ensureLogDir();
    this._writeQueue = [];
    this._flushing = false;

    // Schedule daily log rotation check
    this._rotationTimer = setInterval(() => this._rotateOldLogs(), 3600_000); // hourly
    if (this._rotationTimer.unref) this._rotationTimer.unref();
  }

  _ensureLogDir() {
    try {
      fs.mkdirSync(config.logDir, { recursive: true });
    } catch { /* ignore */ }
  }

  /**
   * Log a completed task execution (async, non-blocking).
   * @returns {object} the log entry
   */
  log(entry) {
    const record = {
      task_id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      description: entry.description || "",
      classification: entry.classification,
      selected_model: entry.selectedModel,
      model_type: entry.modelType,
      input_tokens: entry.inputTokens || 0,
      output_tokens: entry.outputTokens || 0,
      cost: entry.cost || 0,
      execution_time_ms: entry.latencyMs || 0,
      success: entry.success ?? true,
      fallback_model: entry.fallbackModel || null,
      fallback_cost: entry.fallbackCost || null,
      total_cost: (entry.cost || 0) + (entry.fallbackCost || 0),
    };

    // Update Prometheus metrics
    const labels = { model: record.selected_model || "unknown" };
    metrics.smartRouterRequests.inc({
      classification: record.classification,
      model: record.selected_model,
      type: record.model_type,
    });
    if (record.total_cost > 0) {
      metrics.smartRouterCostUsd.inc(labels, record.total_cost);
    }
    if (record.execution_time_ms > 0) {
      metrics.smartRouterLatency.observe(labels, record.execution_time_ms / 1000);
    }

    // Check budget
    this._checkBudget(record.total_cost);

    // Async write (fire-and-forget, with queue)
    this._enqueueWrite(record);

    return record;
  }

  /**
   * Generate a daily summary for a given date.
   */
  dailySummary(dateStr) {
    const date = dateStr || new Date().toISOString().slice(0, 10);
    const entries = this._readLogEntries(date);

    const routine = entries.filter((e) => e.classification === "ROUTINE");
    const important = entries.filter((e) => e.classification === "IMPORTANT");
    const free = entries.filter((e) => e.model_type === "FREE");
    const paid = entries.filter((e) => e.model_type === "PAID");

    const totalCost = entries.reduce((s, e) => s + e.total_cost, 0);
    const paidCost = paid.reduce((s, e) => s + e.total_cost, 0);

    // Baseline: what it would cost if all tasks used Claude Sonnet
    const baselineCost = entries.reduce(
      (s, e) => s + ((e.input_tokens + e.output_tokens) / 1_000_000) * 3,
      0,
    );

    const freeRatio = entries.length > 0 ? (free.length / entries.length) * 100 : 0;

    return {
      date,
      totalTasks: entries.length,
      routineTasks: routine.length,
      importantTasks: important.length,
      freeModelTasks: free.length,
      paidModelTasks: paid.length,
      totalCost: round(totalCost),
      paidCost: round(paidCost),
      baselineCost: round(baselineCost),
      costSaved: round(baselineCost - totalCost),
      costEfficiencyRatio: round(freeRatio),
      successRate: entries.length > 0
        ? round((entries.filter((e) => e.success).length / entries.length) * 100)
        : 100,
      avgLatencyMs: entries.length > 0
        ? Math.round(entries.reduce((s, e) => s + e.execution_time_ms, 0) / entries.length)
        : 0,
      budgetUsed: round(totalCost),
      budgetRemaining: round(config.routing.dailyCostBudget - totalCost),
      budgetWarning: totalCost >= config.routing.dailyCostBudget * config.routing.budgetWarnThreshold,
    };
  }

  /** Get all log entries for a date prefix. */
  getEntries(datePrefix) {
    return this._readLogEntries(datePrefix);
  }

  // ─── Internal ──────────────────────────────────────────

  _logFilePath(date) {
    return path.join(config.logDir, `tasks-${date}.jsonl`);
  }

  _enqueueWrite(record) {
    this._writeQueue.push(record);
    if (!this._flushing) this._flush();
  }

  async _flush() {
    if (this._flushing || this._writeQueue.length === 0) return;
    this._flushing = true;

    try {
      // Group by date for efficient file I/O
      const byDate = new Map();
      while (this._writeQueue.length > 0) {
        const record = this._writeQueue.shift();
        const date = record.timestamp.slice(0, 10);
        if (!byDate.has(date)) byDate.set(date, []);
        byDate.get(date).push(JSON.stringify(record));
      }

      for (const [date, lines] of byDate) {
        const filePath = this._logFilePath(date);
        try {
          await fsp.appendFile(filePath, lines.join("\n") + "\n", "utf8");
        } catch (err) {
          log.error("failed to write log", { error: err.message, date });
        }
      }
    } finally {
      this._flushing = false;
      // If new items arrived during flush, flush again
      if (this._writeQueue.length > 0) this._flush();
    }
  }

  _readLogEntries(datePrefix) {
    if (!datePrefix) datePrefix = new Date().toISOString().slice(0, 10);
    const filePath = this._logFilePath(datePrefix);
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      return raw.split("\n").filter(Boolean).map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean);
    } catch {
      return [];
    }
  }

  _checkBudget(cost) {
    if (cost <= 0) return;
    const summary = this.dailySummary();
    const budget = config.routing.dailyCostBudget;

    metrics.dailySpendUsd.set({}, summary.totalCost);
    metrics.dailyBudgetUsd.set({}, budget);

    if (summary.totalCost >= budget) {
      alerts.alert(AlertType.BUDGET_EXCEEDED,
        `Daily budget exceeded: $${summary.totalCost.toFixed(2)} / $${budget}`,
        { totalCost: summary.totalCost, budget });
    } else if (summary.totalCost >= budget * config.routing.budgetWarnThreshold) {
      alerts.alert(AlertType.BUDGET_WARNING,
        `Daily spend at ${((summary.totalCost / budget) * 100).toFixed(0)}% of budget`,
        { totalCost: summary.totalCost, budget });
    }
  }

  async _rotateOldLogs() {
    const maxDays = config.logRotation.maxDays;
    const cutoffDate = new Date(Date.now() - maxDays * 86400_000);
    const cutoffStr = cutoffDate.toISOString().slice(0, 10);

    try {
      const files = await fsp.readdir(config.logDir);
      for (const file of files) {
        if (!file.startsWith("tasks-") || !file.endsWith(".jsonl")) continue;
        const dateStr = file.slice(6, 16); // "tasks-YYYY-MM-DD.jsonl"
        if (dateStr < cutoffStr) {
          await fsp.unlink(path.join(config.logDir, file));
          log.info("rotated old log file", { file, maxDays });
        }
      }
    } catch (err) {
      log.debug("log rotation check failed", { error: err.message });
    }
  }

  destroy() {
    clearInterval(this._rotationTimer);
  }
}

function round(n) {
  return Math.round(n * 100) / 100;
}
