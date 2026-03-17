// SmartRouter — orchestrator that ties classification, routing, execution,
// cost tracking, auto-scaling, and circuit breakers together.

import { TaskClassifier } from "./task-classifier.js";
import { ModelRouter } from "./model-router.js";
import { FreeModelExecutor, PaidModelExecutor, getCircuitBreakerStatuses } from "./executors.js";
import { CostTracker } from "./cost-tracker.js";
import { AutoScaler } from "./auto-scaler.js";
import config from "./config.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("smart-router");

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
   */
  async process(task) {
    const startMs = Date.now();

    // 1. Classify
    const classification = this.classifier.classify(task);
    log.info("task classified", {
      classification: classification.classification,
      complexity: classification.complexity,
      inputTokens: classification.inputTokens,
    });

    // 2. Route
    let selection = this.router.select(classification);
    if (!selection) {
      throw new Error("No available model — all models disabled or missing API keys");
    }

    // 3. Build messages
    const messages = task.messages || [
      { role: "user", content: task.content || task.description },
    ];

    const opts = {
      temperature: task.temperature,
      maxTokens: task.maxTokens,
    };

    // 4. Execute with retry + fallback
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
        log.warn("model execution failed", {
          model: selection.modelKey,
          attempt: attempts,
          error: err.message,
          circuitOpen: err.name === "CircuitOpenError",
        });

        const fallback = this.scaler.recordFailureAndGetFallback(
          selection.modelKey,
          classification,
        );

        if (!fallback || attempts > maxRetries) {
          this.costTracker.log({
            description: task.description,
            classification: classification.classification,
            selectedModel: selection.modelKey,
            modelType: selection.type,
            success: false,
          });
          throw new Error(`All models failed for task. Last error: ${err.message}`);
        }

        fallbackModel = fallback.modelKey;
        selection = fallback;
        log.info("falling back to next model", { model: fallbackModel });
      }
    }

    // 5. Calculate cost
    const cost = result.cost || 0;
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
      cost: fallbackModel ? 0 : cost,
      latencyMs: result.latencyMs,
      success: true,
      fallbackModel,
      fallbackCost,
    });

    const totalMs = Date.now() - startMs;
    log.info("task completed", {
      model: selection.modelKey,
      type: selection.type,
      cost: logEntry.total_cost,
      latencyMs: totalMs,
      fallback: fallbackModel || null,
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

  getDailySummary(date) {
    return this.costTracker.dailySummary(date);
  }

  getModelStats() {
    return this.scaler.getStats();
  }

  getCircuitBreakers() {
    return getCircuitBreakerStatuses();
  }

  classifyOnly(task) {
    const classification = this.classifier.classify(task);
    const selection = this.router.select(classification);
    return { classification, selectedModel: selection };
  }

  getStatus() {
    return {
      openrouterConfigured: Boolean(config.openrouterApiKey),
      anthropicConfigured: Boolean(config.anthropicApiKey),
      openaiConfigured: Boolean(config.openaiApiKey),
      nvidiaConfigured: Boolean(config.nvidiaApiKey),
      freeModelsAvailable: Boolean(config.openrouterApiKey || config.nvidiaApiKey),
      paidModelsAvailable: Boolean(config.anthropicApiKey || config.openaiApiKey),
      dailyBudget: config.routing.dailyCostBudget,
      logDir: config.logDir,
      circuitBreakers: this.getCircuitBreakers(),
    };
  }

  destroy() {
    this.costTracker.destroy();
  }
}

export { TaskClassifier } from "./task-classifier.js";
export { ModelRouter } from "./model-router.js";
export { FreeModelExecutor, PaidModelExecutor } from "./executors.js";
export { CostTracker } from "./cost-tracker.js";
export { AutoScaler } from "./auto-scaler.js";
export { default as config } from "./config.js";
