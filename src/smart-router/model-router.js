// ModelRouter — selects the optimal model based on task classification.
// Uses escalation chains from config and respects circuit breaker state.

import config from "./config.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("model-router");

export class ModelRouter {
  constructor() {
    this.disabledModels = new Map(); // modelKey → disabledUntil timestamp
  }

  /** Check if NVIDIA direct API is available. */
  get hasNvidiaDirect() {
    return Boolean(config.nvidiaApiKey);
  }

  /**
   * Select the best model for a classified task.
   * @param {object} classification - output from TaskClassifier.classify()
   * @returns {object|null} { modelKey, model, type: "FREE"|"PAID", useNvidiaDirect?: boolean }
   */
  select(classification) {
    const { classification: cls, complexity, inputTokens, hasImage } = classification;

    if (cls === "ROUTINE") {
      return this._selectFreeModel(inputTokens, hasImage, complexity);
    }

    // IMPORTANT tasks: NVIDIA direct (free) → paid
    if (this.hasNvidiaDirect) {
      const nvidia = this._selectNvidiaDirect(complexity, inputTokens);
      if (nvidia) return nvidia;
    }

    return this._selectPaidModel(complexity, hasImage);
  }

  /**
   * Get the next fallback model in the escalation chain.
   */
  getFallback(currentModelKey, classification) {
    const chains = [
      { keys: config.escalationChains.free, models: config.freeModels, type: "FREE" },
      { keys: config.escalationChains.nvidia, models: config.nvidiaDirectModels, type: "FREE", nvidia: true },
      { keys: config.escalationChains.paid, models: config.paidModels, type: "PAID" },
    ];

    // Find which chain the current model is in
    for (let chainIdx = 0; chainIdx < chains.length; chainIdx++) {
      const chain = chains[chainIdx];
      const idx = chain.keys.indexOf(currentModelKey);
      if (idx === -1) continue;

      // Try next models in same chain
      for (let i = idx + 1; i < chain.keys.length; i++) {
        const key = chain.keys[i];
        if (!this._isDisabled(key)) {
          return {
            modelKey: key,
            model: chain.models[key],
            type: chain.type,
            useNvidiaDirect: chain.nvidia || false,
          };
        }
      }

      // Try subsequent chains
      for (let nextChainIdx = chainIdx + 1; nextChainIdx < chains.length; nextChainIdx++) {
        const nextChain = chains[nextChainIdx];
        // Skip NVIDIA chain if no API key
        if (nextChain.nvidia && !this.hasNvidiaDirect) continue;

        for (const key of nextChain.keys) {
          if (!this._isDisabled(key)) {
            return {
              modelKey: key,
              model: nextChain.models[key],
              type: nextChain.type,
              useNvidiaDirect: nextChain.nvidia || false,
            };
          }
        }
      }

      return null; // Exhausted all chains
    }

    return null;
  }

  /** Temporarily disable a model. */
  disableModel(modelKey, durationMs = 300_000) {
    this.disabledModels.set(modelKey, Date.now() + durationMs);
    log.warn("model disabled", { model: modelKey, durationMs });
  }

  _isDisabled(modelKey) {
    const until = this.disabledModels.get(modelKey);
    if (!until) return false;
    if (Date.now() > until) {
      this.disabledModels.delete(modelKey);
      return false;
    }
    return true;
  }

  _selectFreeModel(inputTokens, hasImage, complexity) {
    const { freeModels } = config;

    // Vision requires the VL model
    if (hasImage && !this._isDisabled("nemotron-nano-12b-vl")) {
      return { modelKey: "nemotron-nano-12b-vl", model: freeModels["nemotron-nano-12b-vl"], type: "FREE" };
    }

    // For medium+ complexity, prefer NVIDIA direct if available (better quality, still free)
    if (["medium", "medium_high", "high", "very_high"].includes(complexity) && this.hasNvidiaDirect) {
      const nvidia = this._selectNvidiaDirect(complexity, inputTokens);
      if (nvidia) return nvidia;
    }

    // Use smaller OpenRouter free models based on token count and complexity
    if (inputTokens < 8000 && ["low", "very_low"].includes(complexity) && !this._isDisabled("nemotron-nano-9b")) {
      return { modelKey: "nemotron-nano-9b", model: freeModels["nemotron-nano-9b"], type: "FREE" };
    }
    if (inputTokens < 16000 && !["medium_high", "high", "very_high"].includes(complexity) && !this._isDisabled("nemotron-nano-30b")) {
      return { modelKey: "nemotron-nano-30b", model: freeModels["nemotron-nano-30b"], type: "FREE" };
    }

    // For low-complexity tasks, try NVIDIA direct if available (even though we checked above for medium+)
    if (this.hasNvidiaDirect) {
      const nvidia = this._selectNvidiaDirect(complexity, inputTokens);
      if (nvidia) return nvidia;
    }

    if (!this._isDisabled("nemotron-super-120b")) {
      return { modelKey: "nemotron-super-120b", model: freeModels["nemotron-super-120b"], type: "FREE" };
    }

    // All free models disabled — fall through to paid
    return this._selectPaidModel(complexity, hasImage);
  }

  _selectNvidiaDirect(complexity, inputTokens) {
    const { nvidiaDirectModels } = config;
    const pick = (key) => ({
      modelKey: key, model: nvidiaDirectModels[key], type: "FREE", useNvidiaDirect: true,
    });

    if (["low", "very_low", "low_medium"].includes(complexity) && !this._isDisabled("nvidia-nemotron-nano-30b")) {
      return pick("nvidia-nemotron-nano-30b");
    }
    if (["medium", "medium_high", "high"].includes(complexity) && !this._isDisabled("nvidia-nemotron-super-120b")) {
      return pick("nvidia-nemotron-super-120b");
    }
    if (complexity === "very_high") {
      if (!this._isDisabled("nvidia-deepseek-v3")) return pick("nvidia-deepseek-v3");
      if (!this._isDisabled("nvidia-nemotron-super-120b")) return pick("nvidia-nemotron-super-120b");
    }

    return null;
  }

  _selectPaidModel(complexity, hasImage) {
    const { paidModels } = config;
    const pick = (key) => ({ modelKey: key, model: paidModels[key], type: "PAID" });

    if (hasImage && complexity === "very_high" && !this._isDisabled("gpt-4o")) return pick("gpt-4o");
    if (complexity === "very_high" && !this._isDisabled("claude-3-opus")) return pick("claude-3-opus");
    if (!this._isDisabled("claude-3-5-sonnet")) return pick("claude-3-5-sonnet");

    for (const key of ["gpt-4o", "claude-3-opus"]) {
      if (!this._isDisabled(key)) return pick(key);
    }

    return null;
  }
}
