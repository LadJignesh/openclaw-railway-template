// AutoScaler — handles automatic fallback/escalation when a model fails
// and tracks error rates to temporarily disable unreliable models.

import config from "./config.js";

export class AutoScaler {
  constructor(modelRouter) {
    this.router = modelRouter;
    // Track errors per model: modelKey -> { errors: number, total: number }
    this.stats = new Map();
  }

  /**
   * Record a successful execution for a model.
   */
  recordSuccess(modelKey) {
    const s = this._getStats(modelKey);
    s.total++;
    this._checkErrorRate(modelKey);
  }

  /**
   * Record a failed execution and return a fallback selection (or null).
   * @param {string} modelKey - the model that failed
   * @param {object} classification - original task classification
   * @returns {object|null} fallback { modelKey, model, type } or null
   */
  recordFailureAndGetFallback(modelKey, classification) {
    const s = this._getStats(modelKey);
    s.errors++;
    s.total++;

    this._checkErrorRate(modelKey);

    // Get fallback from router
    return this.router.getFallback(modelKey, classification);
  }

  /**
   * Check if quality score warrants escalation.
   * @param {number} qualityScore - 0-1, from user feedback or heuristic
   * @param {string} currentModelKey
   * @param {object} classification
   * @returns {object|null} escalation target or null
   */
  checkQualityEscalation(qualityScore, currentModelKey, classification) {
    if (qualityScore < config.routing.qualityThreshold) {
      return this.router.getFallback(currentModelKey, classification);
    }
    return null;
  }

  /**
   * Get error stats for all models.
   */
  getStats() {
    const result = {};
    for (const [key, val] of this.stats) {
      result[key] = {
        ...val,
        errorRate: val.total > 0 ? Math.round((val.errors / val.total) * 1000) / 1000 : 0,
      };
    }
    return result;
  }

  /**
   * Reset stats (e.g., daily reset).
   */
  resetStats() {
    this.stats.clear();
  }

  _getStats(modelKey) {
    if (!this.stats.has(modelKey)) {
      this.stats.set(modelKey, { errors: 0, total: 0 });
    }
    return this.stats.get(modelKey);
  }

  _checkErrorRate(modelKey) {
    const s = this._getStats(modelKey);
    if (s.total < 5) return; // need minimum sample size

    const errorRate = s.errors / s.total;
    if (errorRate > config.routing.errorRateThreshold) {
      this.router.disableModel(modelKey, 300_000); // 5 min cooldown
      console.warn(
        `[auto-scaler] disabled ${modelKey} — error rate ${(errorRate * 100).toFixed(1)}% exceeds threshold`,
      );
      // Reset stats after disabling so it gets a fresh chance later
      this.stats.set(modelKey, { errors: 0, total: 0 });
    }
  }
}
