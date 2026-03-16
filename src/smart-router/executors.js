// Model Executors — FreeModelExecutor (OpenRouter) and PaidModelExecutor (Anthropic/OpenAI)

import config from "./config.js";

/**
 * Execute a chat completion against OpenRouter (free Nvidia models).
 */
export class FreeModelExecutor {
  /**
   * @param {object} model - model config from config.freeModels
   * @param {Array} messages - [{ role, content }]
   * @param {object} [opts] - { temperature, maxTokens, timeoutMs }
   * @returns {Promise<{ text, inputTokens, outputTokens, latencyMs }>}
   */
  async execute(model, messages, opts = {}) {
    const apiKey = config.openrouterApiKey;
    if (!apiKey) throw new Error("OPENROUTER_API_KEY not set");

    const temperature = opts.temperature ?? 0.7;
    const maxTokens = opts.maxTokens ?? 1024;
    const timeoutMs = opts.timeoutMs ?? config.routing.requestTimeoutMs;

    const body = {
      model: model.id,
      messages,
      temperature,
      max_tokens: maxTokens,
    };

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
      const choice = data.choices?.[0];

      return {
        text: choice?.message?.content || "",
        inputTokens: data.usage?.prompt_tokens || 0,
        outputTokens: data.usage?.completion_tokens || 0,
        latencyMs,
        model: model.id,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Execute a chat completion against Anthropic (Claude) or OpenAI (GPT-4o).
 */
export class PaidModelExecutor {
  /**
   * @param {object} model - model config from config.paidModels
   * @param {Array} messages - [{ role, content }]
   * @param {object} [opts] - { temperature, maxTokens, timeoutMs }
   * @returns {Promise<{ text, inputTokens, outputTokens, latencyMs, cost }>}
   */
  async execute(model, messages, opts = {}) {
    if (model.provider === "anthropic") {
      return this._executeAnthropic(model, messages, opts);
    }
    if (model.provider === "openai") {
      return this._executeOpenAI(model, messages, opts);
    }
    throw new Error(`Unknown provider: ${model.provider}`);
  }

  async _executeAnthropic(model, messages, opts) {
    const apiKey = config.anthropicApiKey;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

    const temperature = opts.temperature ?? 0.7;
    const maxTokens = opts.maxTokens ?? 2048;
    const timeoutMs = opts.timeoutMs ?? config.routing.requestTimeoutMs;

    // Convert from OpenAI message format to Anthropic format
    const systemMsg = messages.find((m) => m.role === "system");
    const nonSystem = messages.filter((m) => m.role !== "system");

    const body = {
      model: model.id,
      max_tokens: maxTokens,
      temperature,
      messages: nonSystem,
    };
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
      const cost =
        (inputTokens / 1_000_000) * model.costPerMillionInput +
        (outputTokens / 1_000_000) * model.costPerMillionOutput;

      return {
        text: data.content?.[0]?.text || "",
        inputTokens,
        outputTokens,
        latencyMs,
        model: model.id,
        cost,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async _executeOpenAI(model, messages, opts) {
    const apiKey = config.openaiApiKey;
    if (!apiKey) throw new Error("OPENAI_API_KEY not set");

    const temperature = opts.temperature ?? 0.7;
    const maxTokens = opts.maxTokens ?? 2048;
    const timeoutMs = opts.timeoutMs ?? config.routing.requestTimeoutMs;

    const body = {
      model: model.id,
      messages,
      temperature,
      max_tokens: maxTokens,
    };

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
      const cost =
        (inputTokens / 1_000_000) * model.costPerMillionInput +
        (outputTokens / 1_000_000) * model.costPerMillionOutput;

      return {
        text: data.choices?.[0]?.message?.content || "",
        inputTokens,
        outputTokens,
        latencyMs,
        model: model.id,
        cost,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
