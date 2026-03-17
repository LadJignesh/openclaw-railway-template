// Token-bucket rate limiter — no external dependencies.
// Supports per-key (IP) limiting with automatic cleanup.

export class TokenBucketLimiter {
  /**
   * @param {object} opts
   * @param {number} opts.maxTokens - Max tokens per bucket (burst capacity)
   * @param {number} opts.refillRate - Tokens added per second
   * @param {number} [opts.cleanupIntervalMs=60000] - How often to prune stale buckets
   */
  constructor(opts) {
    this.maxTokens = opts.maxTokens;
    this.refillRate = opts.refillRate;
    this.buckets = new Map();
    this._cleanup = setInterval(() => this._prune(), opts.cleanupIntervalMs ?? 60_000);
    // Prevent timer from keeping process alive
    if (this._cleanup.unref) this._cleanup.unref();
  }

  /**
   * Try to consume one token for a key.
   * @param {string} key - Typically an IP address
   * @returns {boolean} true if allowed, false if rate-limited
   */
  consume(key) {
    const now = Date.now();
    let bucket = this.buckets.get(key);

    if (!bucket) {
      bucket = { tokens: this.maxTokens - 1, lastRefill: now };
      this.buckets.set(key, bucket);
      return true;
    }

    // Refill tokens based on elapsed time
    const elapsed = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(this.maxTokens, bucket.tokens + elapsed * this.refillRate);
    bucket.lastRefill = now;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return true;
    }

    return false;
  }

  /**
   * Check remaining tokens for a key without consuming.
   */
  remaining(key) {
    const bucket = this.buckets.get(key);
    if (!bucket) return this.maxTokens;

    const elapsed = (Date.now() - bucket.lastRefill) / 1000;
    return Math.min(this.maxTokens, bucket.tokens + elapsed * this.refillRate);
  }

  _prune() {
    const now = Date.now();
    const staleMs = (this.maxTokens / this.refillRate) * 1000 * 2;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.lastRefill > staleMs) {
        this.buckets.delete(key);
      }
    }
  }

  destroy() {
    clearInterval(this._cleanup);
    this.buckets.clear();
  }
}

/**
 * Express middleware factory.
 * @param {object} opts - { maxTokens, refillRate, keyFn? }
 */
export function rateLimitMiddleware(opts) {
  const limiter = new TokenBucketLimiter(opts);
  const keyFn = opts.keyFn || ((req) => req.ip || req.socket?.remoteAddress || "unknown");

  return (req, res, next) => {
    const key = keyFn(req);
    if (!limiter.consume(key)) {
      res.status(429).set("Retry-After", String(Math.ceil(1 / limiter.refillRate)));
      return res.type("text/plain").send("Too many requests. Try again later.");
    }
    return next();
  };
}
