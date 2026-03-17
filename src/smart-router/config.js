// Smart Router Configuration — all API keys via env var getters.
// Models organized by tier with clear escalation paths.

const config = {
  // API Keys (getters so env vars set after import are respected)
  get openrouterApiKey() { return process.env.OPENROUTER_API_KEY || ""; },
  get anthropicApiKey() { return process.env.ANTHROPIC_API_KEY || ""; },
  get openaiApiKey() { return process.env.OPENAI_API_KEY || ""; },
  get nvidiaApiKey() { return process.env.NVIDIA_API_KEY || ""; },

  // Endpoints
  openrouterBaseUrl: "https://openrouter.ai/api/v1/chat/completions",
  nvidiaBaseUrl: "https://integrate.api.nvidia.com/v1/chat/completions",

  // ═══ MODEL TIERS ═══
  // Tier 0: Free OpenRouter models (no API key cost)
  freeModels: {
    "nemotron-nano-9b": {
      id: "nvidia/nemotron-nano-9b-v2:free",
      name: "Nemotron Nano 9B V2",
      maxInputTokens: 8000,
      complexity: "very_low",
      capabilities: ["text"],
      speedRange: "1-3s",
      costPerMillionTokens: 0,
    },
    "nemotron-nano-30b": {
      id: "nvidia/nemotron-3-nano-30b-a3b:free",
      name: "Nemotron Nano 30B",
      maxInputTokens: 16000,
      complexity: "low_medium",
      capabilities: ["text"],
      speedRange: "2-5s",
      costPerMillionTokens: 0,
    },
    "nemotron-nano-12b-vl": {
      id: "nvidia/nemotron-nano-12b-v2-vl:free",
      name: "Nemotron Nano 12B V2 VL",
      maxInputTokens: 16000,
      complexity: "medium",
      capabilities: ["text", "vision"],
      speedRange: "3-7s",
      costPerMillionTokens: 0,
    },
    "nemotron-super-120b": {
      id: "nvidia/nemotron-3-super-120b-a12b:free",
      name: "Nemotron 3 Super 120B",
      maxInputTokens: 32000,
      complexity: "medium_high",
      capabilities: ["text"],
      speedRange: "5-15s",
      costPerMillionTokens: 0,
    },
  },

  // Tier 1: Direct NVIDIA API (free tier, requires NVIDIA_API_KEY)
  nvidiaDirectModels: {
    "nvidia-nemotron-super-49b": {
      id: "nvidia/llama-3.3-nemotron-super-49b-v1",
      name: "Nemotron Super 49B",
      maxInputTokens: 32000,
      complexity: "medium",
      capabilities: ["text"],
      costPerMillionTokens: 0,
    },
    "nvidia-qwen-122b": {
      id: "qwen/qwen3.5-122b-a10b",
      name: "Qwen 3.5 122B (10B active MoE)",
      maxInputTokens: 32000,
      complexity: "medium_high",
      capabilities: ["text", "reasoning"],
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

  // Tier 2: Paid models (Anthropic, OpenAI)
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

  // ═══ ESCALATION CHAINS ═══
  // Defines the order models are tried during fallback
  escalationChains: {
    free: [
      "nemotron-nano-9b",
      "nemotron-nano-30b",
      "nemotron-nano-12b-vl",
      "nemotron-super-120b",
    ],
    nvidia: [
      "nvidia-nemotron-super-49b",
      "nvidia-qwen-122b",
      "nvidia-nemotron-ultra-253b",
      "nvidia-llama-405b",
      "nvidia-deepseek-r1",
    ],
    paid: ["claude-3-5-sonnet", "claude-3-opus", "gpt-4o"],
  },

  // ═══ ROUTING CONFIG ═══
  routing: {
    freeModelPriority: true,
    dailyCostBudget: parseFloat(process.env.SMART_ROUTER_DAILY_BUDGET || "50"),
    budgetWarnThreshold: 0.8,
    maxRetries: 2,
    requestTimeoutMs: 60000,
    qualityThreshold: 0.7,
    errorRateThreshold: 0.05,
  },

  // ═══ CIRCUIT BREAKER DEFAULTS ═══
  circuitBreaker: {
    failureThreshold: 5,
    resetTimeoutMs: 30_000,
    halfOpenMax: 2,
    successThreshold: 3,
    windowMs: 60_000,
  },

  // ═══ LOG ROTATION ═══
  logRotation: {
    maxDays: parseInt(process.env.SMART_ROUTER_LOG_RETENTION_DAYS || "30", 10),
    maxSizeMb: parseInt(process.env.SMART_ROUTER_LOG_MAX_SIZE_MB || "100", 10),
  },

  // Storage (getter for late binding)
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
