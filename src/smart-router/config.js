// Smart Router Configuration
// All API keys via environment variables — NEVER hardcode secrets.

const config = {
  // API Keys (from environment)
  get openrouterApiKey() { return process.env.OPENROUTER_API_KEY || ""; },
  get anthropicApiKey() { return process.env.ANTHROPIC_API_KEY || ""; },
  get openaiApiKey() { return process.env.OPENAI_API_KEY || ""; },
  get nvidiaApiKey() { return process.env.NVIDIA_API_KEY || ""; },

  // Endpoints
  openrouterBaseUrl: "https://openrouter.ai/api/v1/chat/completions",
  nvidiaBaseUrl: "https://integrate.api.nvidia.com/v1/chat/completions",

  // Free/low-cost Nvidia models — uses direct NVIDIA API if NVIDIA_API_KEY is set,
  // otherwise falls back to OpenRouter free tier.
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

  // Direct NVIDIA API models (requires NVIDIA_API_KEY)
  // These use integrate.api.nvidia.com — not free but very cheap.
  nvidiaDirectModels: {
    "nvidia-nemotron-70b": {
      id: "nvidia/llama-3.1-nemotron-70b-instruct",
      name: "Nemotron 70B Instruct",
      maxInputTokens: 32000,
      complexity: "medium_high",
      capabilities: ["text", "reasoning"],
      costPerMillionTokens: 0,  // free tier on NVIDIA API
    },
    "nvidia-nemotron-super-49b": {
      id: "nvidia/llama-3.3-nemotron-super-49b-v1",
      name: "Nemotron Super 49B",
      maxInputTokens: 32000,
      complexity: "medium",
      capabilities: ["text"],
      costPerMillionTokens: 0,
    },
    "nvidia-nemotron-ultra-253b": {
      id: "nvidia/llama-3.1-nemotron-ultra-253b-v1",
      name: "Nemotron Ultra 253B",
      maxInputTokens: 32000,
      complexity: "high",
      capabilities: ["text", "reasoning"],
      costPerMillionTokens: 0,
    },
    "nvidia-llama-405b": {
      id: "meta/llama-3.1-405b-instruct",
      name: "Llama 3.1 405B",
      maxInputTokens: 128000,
      complexity: "high",
      capabilities: ["text", "reasoning"],
      costPerMillionTokens: 0,
    },
    "nvidia-deepseek-r1": {
      id: "deepseek-ai/deepseek-r1",
      name: "DeepSeek R1",
      maxInputTokens: 64000,
      complexity: "high",
      capabilities: ["text", "reasoning"],
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
