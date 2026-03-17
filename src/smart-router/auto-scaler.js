// AutoScaler — tracks error rates and auto-disables failing models.
// Integrates with the alerting system.

import config from "./config.js";
import { alerts, AlertType } from "../lib/alerts.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("auto-scaler");

export class AutoScaler {
  constructor(modelRouter) {
    this.router = modelRouter;
    this.stats = new Map(); // modelKey → { errors, total, lastError }
  }

  recordSuccess(modelKey) {
    const s = this._getStats(modelKey);
    s.total++;
    this._checkErrorRate(modelKey);
  }

  recordFailureAndGetFallback(modelKey, classification) {
    const s = this._getStats(modelKey);
    s.errors++;
    s.total++;
    s.lastError = new Date().toISOString();

    this._checkErrorRate(modelKey);
    return this.router.getFallback(modelKey, classification);
  }

  checkQualityEscalation(qualityScore, currentModelKey, classification) {
    if (qualityScore < config.routing.qualityThreshold) {
      return this.router.getFallback(currentModelKey, classification);
    }
    return null;
  }

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

  resetStats() {
    this.stats.clear();
  }

  _getStats(modelKey) {
    if (!this.stats.has(modelKey)) {
      this.stats.set(modelKey, { errors: 0, total: 0, lastError: null });
    }
    return this.stats.get(modelKey);
  }

  _checkErrorRate(modelKey) {
    const s = this._getStats(modelKey);
    if (s.total < 5) return; // need minimum sample

    const errorRate = s.errors / s.total;
    if (errorRate > config.routing.errorRateThreshold) {
      this.router.disableModel(modelKey, 300_000);

      const pct = (errorRate * 100).toFixed(1);
      log.warn("model disabled due to high error rate", { model: modelKey, errorRate: pct });

      alerts.alert(AlertType.MODEL_DISABLED,
        `Model ${modelKey} disabled — error rate ${pct}% exceeds threshold`,
        { model: modelKey, errorRate, errors: s.errors, total: s.total });

      // Reset for fair retry after cooldown
      this.stats.set(modelKey, { errors: 0, total: 0, lastError: s.lastError });
    }
  }
}
