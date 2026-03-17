// Model Executors — execute chat completions against various providers.
// Integrated with circuit breakers for fault tolerance.

import config from "./config.js";
import { CircuitBreaker } from "../lib/circuit-breaker.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("executor");

// Per-provider circuit breakers
const breakers = {
  openrouter: new CircuitBreaker({ name: "openrouter", ...config.circuitBreaker }),
  nvidia: new CircuitBreaker({ name: "nvidia-api", ...config.circuitBreaker }),
  anthropic: new CircuitBreaker({ name: "anthropic", ...config.circuitBreaker }),
  openai: new CircuitBreaker({ name: "openai", ...config.circuitBreaker }),
};

/** Get all circuit breaker statuses for monitoring. */
export function getCircuitBreakerStatuses() {
  return Object.fromEntries(
    Object.entries(breakers).map(([k, v]) => [k, v.getStatus()]),
  );
}

/**
 * Execute against OpenRouter or direct NVIDIA API.
 */
export class FreeModelExecutor {
  async execute(model, messages, opts = {}) {
    // Only use NVIDIA direct when explicitly requested (useNvidiaDirect flag)
    // This prevents sending OpenRouter model IDs to the wrong API
    if (opts.useNvidiaDirect) {
      return this._executeNvidiaDirect(model, messages, opts);
    }
    // For free OpenRouter models, use OpenRouter; fall back to NVIDIA if no OpenRouter key
    if (config.openrouterApiKey) {
      return this._executeOpenRouter(model, messages, opts);
    }
    if (config.nvidiaApiKey) {
      return this._executeNvidiaDirect(model, messages, opts);
    }
    throw new Error("No free model API key set — set NVIDIA_API_KEY or OPENROUTER_API_KEY");
  }

  async _executeNvidiaDirect(model, messages, opts) {
    const apiKey = config.nvidiaApiKey;
    if (!apiKey) throw new Error("NVIDIA_API_KEY not set");

    return breakers.nvidia.exec(async () => {
      const temperature = opts.temperature ?? 0.7;
      const maxTokens = opts.maxTokens ?? 4096;
      const timeoutMs = opts.timeoutMs ?? config.routing.requestTimeoutMs;

      const body = { model: model.id, messages, temperature, max_tokens: maxTokens };

      const start = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const res = await fetch(config.nvidiaBaseUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (!res.ok) {
          const errText = await res.text().catch(() => "");
          throw new Error(`NVIDIA API ${res.status}: ${errText.slice(0, 200)}`);
        }

        const data = await res.json();
        const latencyMs = Date.now() - start;

        return {
          text: data.choices?.[0]?.message?.content || "",
          inputTokens: data.usage?.prompt_tokens || 0,
          outputTokens: data.usage?.completion_tokens || 0,
          latencyMs,
          model: model.id,
        };
      } finally {
        clearTimeout(timer);
      }
    });
  }

  async _executeOpenRouter(model, messages, opts) {
    const apiKey = config.openrouterApiKey;
    if (!apiKey) throw new Error("OPENROUTER_API_KEY not set — set NVIDIA_API_KEY or OPENROUTER_API_KEY");

    return breakers.openrouter.exec(async () => {
      const temperature = opts.temperature ?? 0.7;
      const maxTokens = opts.maxTokens ?? 4096;
      const timeoutMs = opts.timeoutMs ?? config.routing.requestTimeoutMs;

      const body = { model: model.id, messages, temperature, max_tokens: maxTokens };

      const start = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const res = await fetch(config.openrouterBaseUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://openclaw-railway.app",
            "X-Title": "OpenClaw Smart Router",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (!res.ok) {
          const errText = await res.text().catch(() => "");
          throw new Error(`OpenRouter ${res.status}: ${errText.slice(0, 200)}`);
        }

        const data = await res.json();
        const latencyMs = Date.now() - start;

        return {
          text: data.choices?.[0]?.message?.content || "",
          inputTokens: data.usage?.prompt_tokens || 0,
          outputTokens: data.usage?.completion_tokens || 0,
          latencyMs,
          model: model.id,
        };
      } finally {
        clearTimeout(timer);
      }
    });
  }
}

/**
 * Execute against Anthropic (Claude) or OpenAI (GPT-4o).
 */
export class PaidModelExecutor {
  async execute(model, messages, opts = {}) {
    if (model.provider === "anthropic") return this._executeAnthropic(model, messages, opts);
    if (model.provider === "openai") return this._executeOpenAI(model, messages, opts);
    throw new Error(`Unknown provider: ${model.provider}`);
  }

  async _executeAnthropic(model, messages, opts) {
    const apiKey = config.anthropicApiKey;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

    return breakers.anthropic.exec(async () => {
      const temperature = opts.temperature ?? 0.7;
      const maxTokens = opts.maxTokens ?? 2048;
      const timeoutMs = opts.timeoutMs ?? config.routing.requestTimeoutMs;

      const systemMsg = messages.find((m) => m.role === "system");
      const nonSystem = messages.filter((m) => m.role !== "system");

      const body = { model: model.id, max_tokens: maxTokens, temperature, messages: nonSystem };
      if (systemMsg) body.system = systemMsg.content;

      const start = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (!res.ok) {
          const errText = await res.text().catch(() => "");
          throw new Error(`Anthropic ${res.status}: ${errText.slice(0, 200)}`);
        }

        const data = await res.json();
        const latencyMs = Date.now() - start;
        const inputTokens = data.usage?.input_tokens || 0;
        const outputTokens = data.usage?.output_tokens || 0;
        const cost = (inputTokens / 1_000_000) * model.costPerMillionInput +
                     (outputTokens / 1_000_000) * model.costPerMillionOutput;

        return {
          text: data.content?.[0]?.text || "",
          inputTokens, outputTokens, latencyMs,
          model: model.id, cost,
        };
      } finally {
        clearTimeout(timer);
      }
    });
  }

  async _executeOpenAI(model, messages, opts) {
    const apiKey = config.openaiApiKey;
    if (!apiKey) throw new Error("OPENAI_API_KEY not set");

    return breakers.openai.exec(async () => {
      const temperature = opts.temperature ?? 0.7;
      const maxTokens = opts.maxTokens ?? 2048;
      const timeoutMs = opts.timeoutMs ?? config.routing.requestTimeoutMs;

      const body = { model: model.id, messages, temperature, max_tokens: maxTokens };

      const start = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const res = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (!res.ok) {
          const errText = await res.text().catch(() => "");
          throw new Error(`OpenAI ${res.status}: ${errText.slice(0, 200)}`);
        }

        const data = await res.json();
        const latencyMs = Date.now() - start;
        const inputTokens = data.usage?.prompt_tokens || 0;
        const outputTokens = data.usage?.completion_tokens || 0;
        const cost = (inputTokens / 1_000_000) * model.costPerMillionInput +
                     (outputTokens / 1_000_000) * model.costPerMillionOutput;

        return {
          text: data.choices?.[0]?.message?.content || "",
          inputTokens, outputTokens, latencyMs,
          model: model.id, cost,
        };
      } finally {
        clearTimeout(timer);
      }
    });
  }
}
