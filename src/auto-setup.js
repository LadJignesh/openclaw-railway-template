// Auto-setup: detects API keys from environment variables and runs
// OpenClaw onboarding automatically (no wizard needed).

/**
 * Provider detection order — first match wins.
 * Each entry: { envVar, authChoice, flag, label }
 */
const PROVIDERS = [
  { envVar: "ANTHROPIC_API_KEY", authChoice: "apiKey", flag: "--anthropic-api-key", label: "Anthropic" },
  { envVar: "OPENAI_API_KEY", authChoice: "openai-api-key", flag: "--openai-api-key", label: "OpenAI" },
  { envVar: "OPENROUTER_API_KEY", authChoice: "openrouter-api-key", flag: "--openrouter-api-key", label: "OpenRouter" },
  { envVar: "GEMINI_API_KEY", authChoice: "gemini-api-key", flag: "--gemini-api-key", label: "Google Gemini" },
  { envVar: "MOONSHOT_API_KEY", authChoice: "moonshot-api-key", flag: "--moonshot-api-key", label: "Moonshot" },
  { envVar: "MINIMAX_API_KEY", authChoice: "minimax-api", flag: "--minimax-api-key", label: "MiniMax" },
];

/**
 * Detect the best available auth provider from environment variables.
 * @returns {{ envVar: string, authChoice: string, flag: string, label: string, secret: string } | null}
 */
export function detectProvider() {
  for (const p of PROVIDERS) {
    const secret = process.env[p.envVar]?.trim();
    if (secret) {
      return { ...p, secret };
    }
  }
  return null;
}

/**
 * Detect channel tokens from environment variables.
 * @returns {{ telegramToken?: string, discordToken?: string, slackBotToken?: string, slackAppToken?: string }}
 */
export function detectChannels() {
  const channels = {};
  const telegram = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (telegram) channels.telegramToken = telegram;

  const discord = process.env.DISCORD_BOT_TOKEN?.trim();
  if (discord) channels.discordToken = discord;

  const slackBot = process.env.SLACK_BOT_TOKEN?.trim();
  if (slackBot) channels.slackBotToken = slackBot;

  const slackApp = process.env.SLACK_APP_TOKEN?.trim();
  if (slackApp) channels.slackAppToken = slackApp;

  return channels;
}

/**
 * Build the payload that the existing onboarding flow expects.
 * Returns null if no provider is detected (cannot auto-setup).
 */
export function buildAutoSetupPayload() {
  const provider = detectProvider();
  if (!provider) return null;

  const channels = detectChannels();

  return {
    flow: "quickstart",
    authChoice: provider.authChoice,
    authSecret: provider.secret,
    model: process.env.OPENCLAW_MODEL?.trim() || "",
    ...channels,
    _provider: provider, // metadata for logging
  };
}
