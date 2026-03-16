// ModelRouter — selects the appropriate model based on task classification.
// Prefers direct NVIDIA API models when NVIDIA_API_KEY is set.

import config from "./config.js";

export class ModelRouter {
  constructor() {
    this.disabledModels = new Map(); // modelKey -> disabledUntil timestamp
  }

  /**
   * Check if NVIDIA direct API is available.
   */
  get hasNvidiaDirect() {
    return Boolean(config.nvidiaApiKey);
  }

  /**
   * Select the best model for a classified task.
   * @param {object} classification - output from TaskClassifier.classify()
   * @returns {object} { modelKey, model, type: "FREE"|"PAID", useNvidiaDirect?: boolean }
   */
  select(classification) {
    const { classification: cls, complexity, inputTokens, hasImage } = classification;

    if (cls === "ROUTINE") {
      return this._selectFreeModel(inputTokens, hasImage, complexity);
    }

    // IMPORTANT tasks: try NVIDIA direct heavy models first (free), then paid
    if (this.hasNvidiaDirect) {
      const nvidia = this._selectNvidiaDirect(complexity, inputTokens);
      if (nvidia) return nvidia;
    }

    return this._selectPaidModel(complexity, hasImage);
  }

  /**
   * Get the fallback model (next tier up) for escalation.
   */
  getFallback(currentModelKey, classification) {
    const freeOrder = [
      "nemotron-nano-9b",
      "nemotron-nano-30b",
      "nemotron-nano-12b-vl",
      "nemotron-super-120b",
    ];
    const nvidiaOrder = [
      "nvidia-nemotron-super-49b",
      "nvidia-nemotron-70b",
      "nvidia-nemotron-ultra-253b",
      "nvidia-llama-405b",
      "nvidia-deepseek-r1",
    ];
    const paidOrder = ["claude-3-5-sonnet", "claude-3-opus", "gpt-4o"];

    // Check free models
    const freeIdx = freeOrder.indexOf(currentModelKey);
    if (freeIdx !== -1) {
      for (let i = freeIdx + 1; i < freeOrder.length; i++) {
        const key = freeOrder[i];
        if (!this._isDisabled(key)) {
          return { modelKey: key, model: config.freeModels[key], type: "FREE" };
        }
      }
      // Try NVIDIA direct before paid
      if (this.hasNvidiaDirect) {
        for (const key of nvidiaOrder) {
          if (!this._isDisabled(key)) {
            return { modelKey: key, model: config.nvidiaDirectModels[key], type: "FREE", useNvidiaDirect: true };
          }
        }
      }
      // Escalate to paid
      for (const key of paidOrder) {
        if (!this._isDisabled(key)) {
          return { modelKey: key, model: config.paidModels[key], type: "PAID" };
        }
      }
    }

    // Check NVIDIA direct models
    const nvidiaIdx = nvidiaOrder.indexOf(currentModelKey);
    if (nvidiaIdx !== -1) {
      for (let i = nvidiaIdx + 1; i < nvidiaOrder.length; i++) {
        const key = nvidiaOrder[i];
        if (!this._isDisabled(key)) {
          return { modelKey: key, model: config.nvidiaDirectModels[key], type: "FREE", useNvidiaDirect: true };
        }
      }
      // Escalate to paid
      for (const key of paidOrder) {
        if (!this._isDisabled(key)) {
          return { modelKey: key, model: config.paidModels[key], type: "PAID" };
        }
      }
    }

    // Check paid models
    const paidIdx = paidOrder.indexOf(currentModelKey);
    if (paidIdx !== -1) {
      for (let i = paidIdx + 1; i < paidOrder.length; i++) {
        const key = paidOrder[i];
        if (!this._isDisabled(key)) {
          return { modelKey: key, model: config.paidModels[key], type: "PAID" };
        }
      }
    }

    return null; // No fallback available
  }

  /**
   * Temporarily disable a model (e.g., high error rate).
   */
  disableModel(modelKey, durationMs = 300000) {
    this.disabledModels.set(modelKey, Date.now() + durationMs);
    console.warn(`[smart-router] model ${modelKey} disabled for ${durationMs / 1000}s`);
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
    // If NVIDIA direct API is available, prefer it for routine tasks too
    if (this.hasNvidiaDirect) {
      const nvidia = this._selectNvidiaDirect(complexity, inputTokens);
      if (nvidia) return nvidia;
    }

    const { freeModels } = config;

    if (hasImage && !this._isDisabled("nemotron-nano-12b-vl")) {
      return { modelKey: "nemotron-nano-12b-vl", model: freeModels["nemotron-nano-12b-vl"], type: "FREE" };
    }

    if (inputTokens < 1000 && !this._isDisabled("nemotron-nano-9b")) {
      return { modelKey: "nemotron-nano-9b", model: freeModels["nemotron-nano-9b"], type: "FREE" };
    }

    if (inputTokens < 2000 && complexity !== "medium_high" && !this._isDisabled("nemotron-nano-30b")) {
      return { modelKey: "nemotron-nano-30b", model: freeModels["nemotron-nano-30b"], type: "FREE" };
    }

    if (!this._isDisabled("nemotron-super-120b")) {
      return { modelKey: "nemotron-super-120b", model: freeModels["nemotron-super-120b"], type: "FREE" };
    }

    // All free models disabled — fall through to paid
    return this._selectPaidModel(complexity, hasImage);
  }

  /**
   * Select a direct NVIDIA API model based on complexity.
   */
  _selectNvidiaDirect(complexity, inputTokens) {
    const { nvidiaDirectModels } = config;

    if (["low", "very_low"].includes(complexity)) {
      if (!this._isDisabled("nvidia-nemotron-super-49b")) {
        return { modelKey: "nvidia-nemotron-super-49b", model: nvidiaDirectModels["nvidia-nemotron-super-49b"], type: "FREE", useNvidiaDirect: true };
      }
    }

    if (["low_medium", "medium"].includes(complexity)) {
      if (!this._isDisabled("nvidia-nemotron-70b")) {
        return { modelKey: "nvidia-nemotron-70b", model: nvidiaDirectModels["nvidia-nemotron-70b"], type: "FREE", useNvidiaDirect: true };
      }
    }

    if (complexity === "medium_high" || complexity === "high") {
      if (!this._isDisabled("nvidia-nemotron-ultra-253b")) {
        return { modelKey: "nvidia-nemotron-ultra-253b", model: nvidiaDirectModels["nvidia-nemotron-ultra-253b"], type: "FREE", useNvidiaDirect: true };
      }
    }

    if (complexity === "very_high") {
      // DeepSeek R1 for maximum reasoning, Llama 405B as fallback
      if (!this._isDisabled("nvidia-deepseek-r1")) {
        return { modelKey: "nvidia-deepseek-r1", model: nvidiaDirectModels["nvidia-deepseek-r1"], type: "FREE", useNvidiaDirect: true };
      }
      if (!this._isDisabled("nvidia-llama-405b")) {
        return { modelKey: "nvidia-llama-405b", model: nvidiaDirectModels["nvidia-llama-405b"], type: "FREE", useNvidiaDirect: true };
      }
    }

    return null;
  }

  _selectPaidModel(complexity, hasImage) {
    const { paidModels } = config;

    if (hasImage && complexity === "very_high" && !this._isDisabled("gpt-4o")) {
      return { modelKey: "gpt-4o", model: paidModels["gpt-4o"], type: "PAID" };
    }

    if (complexity === "very_high" && !this._isDisabled("claude-3-opus")) {
      return { modelKey: "claude-3-opus", model: paidModels["claude-3-opus"], type: "PAID" };
    }

    if (!this._isDisabled("claude-3-5-sonnet")) {
      return { modelKey: "claude-3-5-sonnet", model: paidModels["claude-3-5-sonnet"], type: "PAID" };
    }

    // Last resort
    for (const key of ["gpt-4o", "claude-3-opus"]) {
      if (!this._isDisabled(key)) {
        return { modelKey: key, model: paidModels[key], type: "PAID" };
      }
    }

    return null;
  }
}
