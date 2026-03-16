// CostTracker — logs every task execution, tracks daily costs, generates reports.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import config from "./config.js";

export class CostTracker {
  constructor() {
    this._ensureLogDir();
  }

  _ensureLogDir() {
    try {
      fs.mkdirSync(config.logDir, { recursive: true });
    } catch {
      // ignore — might be read-only in some envs
    }
  }

  /**
   * Log a completed task execution.
   * @returns {object} the log entry (with task_id)
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

    this._appendToLog(record);
    return record;
  }

  /**
   * Generate a daily summary for a given date (defaults to today).
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

    // Estimate what it would have cost if all tasks used Claude Sonnet ($3/M input)
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

  /**
   * Get all log entries (optionally filtered by date prefix).
   */
  getEntries(datePrefix) {
    return this._readLogEntries(datePrefix);
  }

  // --- Internal ---

  _logFilePath(date) {
    return path.join(config.logDir, `tasks-${date}.jsonl`);
  }

  _appendToLog(record) {
    const date = record.timestamp.slice(0, 10);
    const filePath = this._logFilePath(date);
    try {
      fs.appendFileSync(filePath, JSON.stringify(record) + "\n", "utf8");
    } catch (err) {
      console.error(`[cost-tracker] failed to write log: ${err.message}`);
    }
  }

  _readLogEntries(datePrefix) {
    if (!datePrefix) datePrefix = new Date().toISOString().slice(0, 10);

    const filePath = this._logFilePath(datePrefix);
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      return raw
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  }
}

function round(n) {
  return Math.round(n * 100) / 100;
}
