// Smart Router Configuration
// All API keys via environment variables — NEVER hardcode secrets.

const config = {
  // API Keys (from environment)
  openrouterApiKey: process.env.OPENROUTER_API_KEY || "",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
  openaiApiKey: process.env.OPENAI_API_KEY || "",

  // OpenRouter endpoint for free Nvidia models
  openrouterBaseUrl: "https://openrouter.ai/api/v1/chat/completions",

  // Free Nvidia models (via OpenRouter)
  freeModels: {
    "nemotron-nano-9b": {
      id: "nvidia/nemotron-nano-9b-v2:free",
      name: "Nemotron Nano 9B V2",
      maxInputTokens: 1000,
      complexity: "very_low",
      capabilities: ["text"],
      speedRange: "1-3s",
      costPerMillionTokens: 0,
    },
    "nemotron-nano-30b": {
      id: "nvidia/nemotron-3-nano-30b-a3b:free",
      name: "Nemotron Nano 30B",
      maxInputTokens: 2000,
      complexity: "low_medium",
      capabilities: ["text"],
      speedRange: "2-5s",
      costPerMillionTokens: 0,
    },
    "nemotron-nano-12b-vl": {
      id: "nvidia/nemotron-nano-12b-v2-vl:free",
      name: "Nemotron Nano 12B V2 VL",
      maxInputTokens: 4000,
      complexity: "medium",
      capabilities: ["text", "vision"],
      speedRange: "3-7s",
      costPerMillionTokens: 0,
    },
    "nemotron-super-120b": {
      id: "nvidia/nemotron-3-super-120b-a12b:free",
      name: "Nemotron 3 Super 120B",
      maxInputTokens: 10000,
      complexity: "medium_high",
      capabilities: ["text"],
      speedRange: "5-15s",
      costPerMillionTokens: 0,
    },
  },

  // Paid models
  paidModels: {
    "claude-3-5-sonnet": {
      id: "claude-3-5-sonnet-20241022",
      provider: "anthropic",
      name: "Claude 3.5 Sonnet",
      costPerMillionInput: 3.0,
      costPerMillionOutput: 15.0,
      capabilities: ["text", "vision", "reasoning"],
      useCase: "Complex reasoning, architecture, debugging",
    },
    "claude-3-opus": {
      id: "claude-3-opus-20240229",
      provider: "anthropic",
      name: "Claude 3 Opus",
      costPerMillionInput: 15.0,
      costPerMillionOutput: 75.0,
      capabilities: ["text", "vision", "reasoning", "deep_analysis"],
      useCase: "Strategic planning, maximum accuracy",
    },
    "gpt-4o": {
      id: "gpt-4o",
      provider: "openai",
      name: "GPT-4o",
      costPerMillionInput: 5.0,
      costPerMillionOutput: 15.0,
      capabilities: ["text", "vision", "multimodal"],
      useCase: "Complex multimodal, video understanding",
    },
  },

  // Routing configuration
  routing: {
    freeModelPriority: true,
    escalationThreshold: "high",
    dailyCostBudget: parseFloat(process.env.SMART_ROUTER_DAILY_BUDGET || "50"),
    budgetWarnThreshold: 0.8,
    enableAutoLogging: true,
    maxRetries: 2,
    requestTimeoutMs: 30000,
    qualityThreshold: 0.7, // auto-escalate if quality score below this
    errorRateThreshold: 0.05, // disable model if error rate > 5%
  },

  // Storage paths (getter so env vars set after import are respected)
  get logDir() {
    return (
      process.env.SMART_ROUTER_LOG_DIR ||
      (process.env.OPENCLAW_STATE_DIR
        ? `${process.env.OPENCLAW_STATE_DIR}/smart-router-logs`
        : "/data/.openclaw/smart-router-logs")
    );
  },
};

export default config;
