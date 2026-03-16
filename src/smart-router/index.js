// SmartRouter — main orchestrator that ties classification, routing, execution,
// cost tracking, and auto-scaling together.

import { TaskClassifier } from "./task-classifier.js";
import { ModelRouter } from "./model-router.js";
import { FreeModelExecutor, PaidModelExecutor } from "./executors.js";
import { CostTracker } from "./cost-tracker.js";
import { AutoScaler } from "./auto-scaler.js";
import config from "./config.js";

export class SmartRouter {
  constructor() {
    this.classifier = new TaskClassifier();
    this.router = new ModelRouter();
    this.freeExecutor = new FreeModelExecutor();
    this.paidExecutor = new PaidModelExecutor();
    this.costTracker = new CostTracker();
    this.scaler = new AutoScaler(this.router);
  }

  /**
   * Process a task end-to-end: classify → route → execute → log.
   *
   * @param {object} task - {
   *   description: string,       // brief task description for logging
   *   content: string,           // the actual prompt / input text
   *   hasImage?: boolean,        // whether task includes image input
   *   priority?: "low"|"high"|"critical",  // manual override
   *   messages?: Array,          // pre-built messages array (overrides content)
   *   temperature?: number,
   *   maxTokens?: number,
   * }
   * @returns {Promise<object>} { text, classification, modelUsed, cost, logEntry }
   */
  async process(task) {
    // 1. Classify
    const classification = this.classifier.classify(task);

    // 2. Route
    let selection = this.router.select(classification);
    if (!selection) {
      throw new Error("No available model for this task — all models disabled or missing API keys");
    }

    // 3. Build messages
    const messages = task.messages || [
      { role: "user", content: task.content || task.description },
    ];

    const opts = {
      temperature: task.temperature,
      maxTokens: task.maxTokens,
    };

    // 4. Execute (with fallback)
    let result;
    let fallbackModel = null;
    let fallbackCost = null;
    let attempts = 0;
    const maxRetries = config.routing.maxRetries;

    while (attempts <= maxRetries) {
      try {
        const executor = selection.type === "FREE" ? this.freeExecutor : this.paidExecutor;
        const execOpts = { ...opts, useNvidiaDirect: selection.useNvidiaDirect };
        result = await executor.execute(selection.model, messages, execOpts);
        this.scaler.recordSuccess(selection.modelKey);
        break;
      } catch (err) {
        attempts++;
        console.error(
          `[smart-router] ${selection.modelKey} failed (attempt ${attempts}): ${err.message}`,
        );

        const fallback = this.scaler.recordFailureAndGetFallback(
          selection.modelKey,
          classification,
        );

        if (!fallback || attempts > maxRetries) {
          // Log the failure and re-throw
          this.costTracker.log({
            description: task.description,
            classification: classification.classification,
            selectedModel: selection.modelKey,
            modelType: selection.type,
            success: false,
          });
          throw new Error(
            `All models failed for task. Last error: ${err.message}`,
          );
        }

        fallbackModel = fallback.modelKey;
        selection = fallback;
      }
    }

    // 5. Calculate cost
    const cost = result.cost || 0; // free models have cost=0

    if (fallbackModel && selection.type === "PAID") {
      fallbackCost = cost;
    }

    // 6. Log
    const logEntry = this.costTracker.log({
      description: task.description,
      classification: classification.classification,
      selectedModel: selection.modelKey,
      modelType: selection.type,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      cost: fallbackModel ? 0 : cost, // original cost was 0 if it failed
      latencyMs: result.latencyMs,
      success: true,
      fallbackModel,
      fallbackCost,
    });

    return {
      text: result.text,
      classification: classification.classification,
      complexity: classification.complexity,
      modelUsed: selection.modelKey,
      modelType: selection.type,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      cost: logEntry.total_cost,
      latencyMs: result.latencyMs,
      logEntry,
    };
  }

  /**
   * Get daily cost summary.
   */
  getDailySummary(date) {
    return this.costTracker.dailySummary(date);
  }

  /**
   * Get model health stats.
   */
  getModelStats() {
    return this.scaler.getStats();
  }

  /**
   * Classify a task without executing (for preview/dry-run).
   */
  classifyOnly(task) {
    const classification = this.classifier.classify(task);
    const selection = this.router.select(classification);
    return { classification, selectedModel: selection };
  }

  /**
   * Check system readiness (which API keys are configured).
   */
  getStatus() {
    return {
      openrouterConfigured: Boolean(config.openrouterApiKey),
      anthropicConfigured: Boolean(config.anthropicApiKey),
      openaiConfigured: Boolean(config.openaiApiKey),
      freeModelsAvailable: Boolean(config.openrouterApiKey),
      paidModelsAvailable: Boolean(config.anthropicApiKey || config.openaiApiKey),
      dailyBudget: config.routing.dailyCostBudget,
      logDir: config.logDir,
    };
  }
}

// Re-export all components for direct access
export { TaskClassifier } from "./task-classifier.js";
export { ModelRouter } from "./model-router.js";
export { FreeModelExecutor, PaidModelExecutor } from "./executors.js";
export { CostTracker } from "./cost-tracker.js";
export { AutoScaler } from "./auto-scaler.js";
export { default as config } from "./config.js";
