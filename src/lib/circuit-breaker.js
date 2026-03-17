// Circuit Breaker — prevents cascading failures by failing fast
// when a downstream service is unhealthy.
//
// States: CLOSED (normal) → OPEN (failing fast) → HALF_OPEN (testing recovery)

import { createLogger } from "./logger.js";

const log = createLogger("circuit-breaker");

export const State = { CLOSED: "CLOSED", OPEN: "OPEN", HALF_OPEN: "HALF_OPEN" };

export class CircuitBreaker {
  /**
   * @param {object} opts
   * @param {string} opts.name - Identifier for logging
   * @param {number} [opts.failureThreshold=5] - Failures before opening
   * @param {number} [opts.resetTimeoutMs=30000] - Time in OPEN before trying HALF_OPEN
   * @param {number} [opts.halfOpenMax=2] - Max concurrent requests in HALF_OPEN
   * @param {number} [opts.successThreshold=3] - Successes in HALF_OPEN to close
   * @param {number} [opts.windowMs=60000] - Sliding window for failure counting
   */
  constructor(opts = {}) {
    this.name = opts.name || "default";
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.resetTimeoutMs = opts.resetTimeoutMs ?? 30_000;
    this.halfOpenMax = opts.halfOpenMax ?? 2;
    this.successThreshold = opts.successThreshold ?? 3;
    this.windowMs = opts.windowMs ?? 60_000;

    this.state = State.CLOSED;
    this.failures = [];          // timestamps of failures within window
    this.halfOpenAttempts = 0;
    this.halfOpenSuccesses = 0;
    this.lastFailure = null;
    this.openedAt = null;
    this.stats = { total: 0, success: 0, failure: 0, rejected: 0 };
  }

  /**
   * Execute a function through the circuit breaker.
   * @param {Function} fn - Async function to execute
   * @returns {Promise<*>} Result of fn
   * @throws {Error} If circuit is open or fn fails
   */
  async exec(fn) {
    this.stats.total++;
    this._pruneFailures();

    if (this.state === State.OPEN) {
      if (Date.now() - this.openedAt >= this.resetTimeoutMs) {
        this._transitionTo(State.HALF_OPEN);
      } else {
        this.stats.rejected++;
        throw new CircuitOpenError(this.name, this.resetTimeoutMs - (Date.now() - this.openedAt));
      }
    }

    if (this.state === State.HALF_OPEN && this.halfOpenAttempts >= this.halfOpenMax) {
      this.stats.rejected++;
      throw new CircuitOpenError(this.name, 0);
    }

    if (this.state === State.HALF_OPEN) {
      this.halfOpenAttempts++;
    }

    try {
      const result = await fn();
      this._onSuccess();
      return result;
    } catch (err) {
      this._onFailure(err);
      throw err;
    }
  }

  _onSuccess() {
    this.stats.success++;
    if (this.state === State.HALF_OPEN) {
      this.halfOpenSuccesses++;
      if (this.halfOpenSuccesses >= this.successThreshold) {
        this._transitionTo(State.CLOSED);
      }
    }
  }

  _onFailure(err) {
    this.stats.failure++;
    this.lastFailure = { at: Date.now(), message: err.message };
    this.failures.push(Date.now());

    if (this.state === State.HALF_OPEN) {
      this._transitionTo(State.OPEN);
      return;
    }

    if (this.state === State.CLOSED && this.failures.length >= this.failureThreshold) {
      this._transitionTo(State.OPEN);
    }
  }

  _transitionTo(newState) {
    const prev = this.state;
    this.state = newState;

    if (newState === State.OPEN) {
      this.openedAt = Date.now();
      log.warn(`${this.name}: ${prev} → OPEN`, { failures: this.failures.length });
    } else if (newState === State.HALF_OPEN) {
      this.halfOpenAttempts = 0;
      this.halfOpenSuccesses = 0;
      log.info(`${this.name}: OPEN → HALF_OPEN (testing recovery)`);
    } else if (newState === State.CLOSED) {
      this.failures = [];
      this.halfOpenAttempts = 0;
      this.halfOpenSuccesses = 0;
      log.info(`${this.name}: ${prev} → CLOSED (recovered)`);
    }
  }

  _pruneFailures() {
    const cutoff = Date.now() - this.windowMs;
    this.failures = this.failures.filter((t) => t > cutoff);
  }

  /** Get current breaker status for monitoring. */
  getStatus() {
    return {
      name: this.name,
      state: this.state,
      failures: this.failures.length,
      lastFailure: this.lastFailure,
      stats: { ...this.stats },
    };
  }

  /** Force reset to CLOSED. */
  reset() {
    this._transitionTo(State.CLOSED);
  }
}

export class CircuitOpenError extends Error {
  constructor(name, retryAfterMs) {
    super(`Circuit breaker "${name}" is OPEN — retry after ${Math.ceil(retryAfterMs / 1000)}s`);
    this.name = "CircuitOpenError";
    this.retryAfterMs = retryAfterMs;
  }
}
