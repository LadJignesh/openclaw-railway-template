// Prometheus-compatible metrics collector.
// Supports counters, gauges, and histograms — no external deps.

class Counter {
  constructor(name, help, labels = []) {
    this.name = name;
    this.help = help;
    this.labels = labels;
    this.values = new Map();
  }

  inc(labelValues = {}, value = 1) {
    const key = this._key(labelValues);
    this.values.set(key, (this.values.get(key) || 0) + value);
  }

  _key(labelValues) {
    if (this.labels.length === 0) return "";
    return this.labels.map((l) => `${l}="${labelValues[l] || ""}"`).join(",");
  }

  serialize() {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    if (this.values.size === 0) {
      lines.push(`${this.name} 0`);
    } else {
      for (const [key, val] of this.values) {
        lines.push(key ? `${this.name}{${key}} ${val}` : `${this.name} ${val}`);
      }
    }
    return lines.join("\n");
  }
}

class Gauge {
  constructor(name, help, labels = []) {
    this.name = name;
    this.help = help;
    this.labels = labels;
    this.values = new Map();
  }

  set(labelValues = {}, value) {
    const key = this._key(labelValues);
    this.values.set(key, value);
  }

  inc(labelValues = {}, value = 1) {
    const key = this._key(labelValues);
    this.values.set(key, (this.values.get(key) || 0) + value);
  }

  _key(labelValues) {
    if (this.labels.length === 0) return "";
    return this.labels.map((l) => `${l}="${labelValues[l] || ""}"`).join(",");
  }

  serialize() {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    if (this.values.size === 0) {
      lines.push(`${this.name} 0`);
    } else {
      for (const [key, val] of this.values) {
        lines.push(key ? `${this.name}{${key}} ${val}` : `${this.name} ${val}`);
      }
    }
    return lines.join("\n");
  }
}

class Histogram {
  constructor(name, help, labels = [], buckets = [0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30, 60]) {
    this.name = name;
    this.help = help;
    this.labels = labels;
    this.buckets = buckets.sort((a, b) => a - b);
    this.observations = new Map(); // key → { sum, count, buckets: Map<boundary, count> }
  }

  observe(labelValues = {}, value) {
    const key = this._key(labelValues);
    let obs = this.observations.get(key);
    if (!obs) {
      obs = { sum: 0, count: 0, buckets: new Map() };
      for (const b of this.buckets) obs.buckets.set(b, 0);
      this.observations.set(key, obs);
    }
    obs.sum += value;
    obs.count++;
    for (const b of this.buckets) {
      if (value <= b) obs.buckets.set(b, obs.buckets.get(b) + 1);
    }
  }

  _key(labelValues) {
    if (this.labels.length === 0) return "";
    return this.labels.map((l) => `${l}="${labelValues[l] || ""}"`).join(",");
  }

  serialize() {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [key, obs] of this.observations) {
      const prefix = key ? `{${key},` : "{";
      const suffix = key ? "}" : "}";
      for (const [b, count] of obs.buckets) {
        lines.push(`${this.name}_bucket${prefix}le="${b}"${suffix} ${count}`);
      }
      lines.push(`${this.name}_bucket${prefix}le="+Inf"${suffix} ${obs.count}`);
      lines.push(`${this.name}_sum${key ? `{${key}}` : ""} ${obs.sum}`);
      lines.push(`${this.name}_count${key ? `{${key}}` : ""} ${obs.count}`);
    }
    return lines.join("\n");
  }
}

class MetricsRegistry {
  constructor() {
    this.metrics = new Map();
    this.startedAt = Date.now();
  }

  counter(name, help, labels) {
    if (!this.metrics.has(name)) this.metrics.set(name, new Counter(name, help, labels));
    return this.metrics.get(name);
  }

  gauge(name, help, labels) {
    if (!this.metrics.has(name)) this.metrics.set(name, new Gauge(name, help, labels));
    return this.metrics.get(name);
  }

  histogram(name, help, labels, buckets) {
    if (!this.metrics.has(name)) this.metrics.set(name, new Histogram(name, help, labels, buckets));
    return this.metrics.get(name);
  }

  /** Serialize all metrics in Prometheus exposition format. */
  serialize() {
    const lines = [];
    // Add process uptime
    lines.push(`# HELP process_uptime_seconds Process uptime`);
    lines.push(`# TYPE process_uptime_seconds gauge`);
    lines.push(`process_uptime_seconds ${((Date.now() - this.startedAt) / 1000).toFixed(1)}`);
    lines.push("");

    for (const metric of this.metrics.values()) {
      lines.push(metric.serialize());
      lines.push("");
    }
    return lines.join("\n");
  }
}

// Singleton registry
export const registry = new MetricsRegistry();

// Pre-defined metrics
export const httpRequestsTotal = registry.counter(
  "openclaw_http_requests_total", "Total HTTP requests", ["method", "path", "status"]
);
export const httpRequestDuration = registry.histogram(
  "openclaw_http_request_duration_seconds", "HTTP request duration", ["method", "path"],
  [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]
);
export const gatewayStatus = registry.gauge(
  "openclaw_gateway_status", "Gateway status (1=ready, 0=down)"
);
export const gatewayRestarts = registry.counter(
  "openclaw_gateway_restarts_total", "Total gateway restarts"
);
export const smartRouterRequests = registry.counter(
  "openclaw_smart_router_requests_total", "Smart router requests", ["classification", "model", "type"]
);
export const smartRouterCostUsd = registry.counter(
  "openclaw_smart_router_cost_usd_total", "Total cost in USD", ["model"]
);
export const smartRouterLatency = registry.histogram(
  "openclaw_smart_router_latency_seconds", "Smart router request latency", ["model"],
  [0.1, 0.5, 1, 2, 5, 10, 30, 60]
);
export const circuitBreakerState = registry.gauge(
  "openclaw_circuit_breaker_state", "Circuit breaker state (0=closed, 1=open, 2=half_open)", ["name"]
);
export const dailySpendUsd = registry.gauge(
  "openclaw_daily_spend_usd", "Daily spend in USD"
);
export const dailyBudgetUsd = registry.gauge(
  "openclaw_daily_budget_usd", "Daily budget in USD"
);
