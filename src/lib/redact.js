// Secret redaction — strips API keys, tokens, and credentials from text.
// Used for log output, debug console responses, and error messages.

let _gatewayToken = "";

/** Set the gateway token so it can be redacted from output. */
export function setGatewayToken(token) {
  _gatewayToken = token;
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const PATTERNS = [
  // OpenAI API keys (sk-proj-..., sk-...)
  /(sk-(?:proj-)?[A-Za-z0-9_-]{10,})/g,
  // Anthropic API keys (sk-ant-...)
  /(sk-ant-[A-Za-z0-9_-]{10,})/g,
  // GitHub tokens (gho_, ghp_, ghs_, ghr_)
  /(gh[opsr]_[A-Za-z0-9_]{10,})/g,
  // Slack tokens
  /(xox[baprs]-[A-Za-z0-9-]{10,})/g,
  // Telegram bot tokens (123456:ABCDEF...)
  /(\d{5,}:[A-Za-z0-9_-]{10,})/g,
  // Anthropic setup tokens (AA...:...)
  /(AA[A-Za-z0-9_-]{10,}:\S{10,})/g,
  // Google API keys (AIza...)
  /(AIza[A-Za-z0-9_-]{30,})/g,
  // OpenRouter API keys (sk-or-...)
  /(sk-or-[A-Za-z0-9_-]{10,})/g,
  // NVIDIA API keys (nvapi-...)
  /(nvapi-[A-Za-z0-9_-]{10,})/g,
  // Discord bot tokens (base64-ish)
  /((?:Bot\s+)?[A-Za-z0-9]{24,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,})/g,
  // Generic bearer tokens in output
  /(Bearer\s+)[A-Za-z0-9_.-]{20,}/gi,
  // MiniMax API keys
  /(eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,})/g,
];

/**
 * Redact secrets from text.
 * @param {string} text
 * @returns {string} Text with secrets replaced by [REDACTED]
 */
export function redactSecrets(text) {
  if (!text) return text;
  let result = String(text);

  for (const pattern of PATTERNS) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0;
    result = result.replace(pattern, (match, group1) => {
      // For Bearer pattern, preserve the "Bearer " prefix
      if (match.toLowerCase().startsWith("bearer ")) {
        return group1 + "[REDACTED]";
      }
      return "[REDACTED]";
    });
  }

  // Redact gateway token if set
  if (_gatewayToken && _gatewayToken.length > 8) {
    result = result.replace(new RegExp(escapeRegExp(_gatewayToken), "g"), "[REDACTED]");
  }

  return result;
}
