// ModelRouter — selects the appropriate model based on task classification.

import config from "./config.js";

export class ModelRouter {
  constructor() {
    this.disabledModels = new Map(); // modelKey -> disabledUntil timestamp
  }

  /**
   * Select the best model for a classified task.
   * @param {object} classification - output from TaskClassifier.classify()
   * @returns {object} { modelKey, model, type: "FREE"|"PAID" }
   */
  select(classification) {
    const { classification: cls, complexity, inputTokens, hasImage } = classification;

    if (cls === "ROUTINE") {
      return this._selectFreeModel(inputTokens, hasImage, complexity);
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
    const paidOrder = ["claude-3-5-sonnet", "claude-3-opus", "gpt-4o"];

    // If current is free, try next free model, then paid
    const freeIdx = freeOrder.indexOf(currentModelKey);
    if (freeIdx !== -1) {
      for (let i = freeIdx + 1; i < freeOrder.length; i++) {
        const key = freeOrder[i];
        if (!this._isDisabled(key)) {
          return { modelKey: key, model: config.freeModels[key], type: "FREE" };
        }
      }
      // Escalate to paid
      for (const key of paidOrder) {
        if (!this._isDisabled(key)) {
          return { modelKey: key, model: config.paidModels[key], type: "PAID" };
        }
      }
    }

    // If current is paid, try next paid model
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
