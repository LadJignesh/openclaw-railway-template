// Alerting system — sends notifications via webhooks on critical events.
// Supports Slack, Discord, and generic JSON webhooks.
// Deduplicates alerts to prevent spam.

import { createLogger } from "./logger.js";

const log = createLogger("alerts");

// Alert types with severity
export const AlertType = {
  BUDGET_WARNING: "budget_warning",
  BUDGET_EXCEEDED: "budget_exceeded",
  GATEWAY_DOWN: "gateway_down",
  GATEWAY_CRASH_LOOP: "gateway_crash_loop",
  MODEL_DISABLED: "model_disabled",
  HIGH_ERROR_RATE: "high_error_rate",
  CIRCUIT_OPEN: "circuit_open",
  AUTO_SETUP_FAILED: "auto_setup_failed",
};

const SEVERITY = {
  [AlertType.BUDGET_WARNING]: "warning",
  [AlertType.BUDGET_EXCEEDED]: "critical",
  [AlertType.GATEWAY_DOWN]: "critical",
  [AlertType.GATEWAY_CRASH_LOOP]: "critical",
  [AlertType.MODEL_DISABLED]: "warning",
  [AlertType.HIGH_ERROR_RATE]: "warning",
  [AlertType.CIRCUIT_OPEN]: "warning",
  [AlertType.AUTO_SETUP_FAILED]: "critical",
};

class AlertManager {
  constructor() {
    this.webhookUrl = process.env.ALERT_WEBHOOK_URL?.trim() || null;
    this.webhookType = process.env.ALERT_WEBHOOK_TYPE?.trim()?.toLowerCase() || "generic"; // slack, discord, generic
    this.cooldowns = new Map(); // alertType → lastSentAt
    this.cooldownMs = parseInt(process.env.ALERT_COOLDOWN_MS || "300000", 10); // 5 min default
    this.history = []; // last 100 alerts
    this.maxHistory = 100;
  }

  /**
   * Send an alert if not in cooldown.
   * @param {string} type - AlertType
   * @param {string} message - Human-readable message
   * @param {object} [data] - Additional context
   */
  async alert(type, message, data = {}) {
    const severity = SEVERITY[type] || "info";
    const entry = {
      type,
      severity,
      message,
      data,
      timestamp: new Date().toISOString(),
      sent: false,
    };

    this.history.push(entry);
    if (this.history.length > this.maxHistory) this.history.shift();

    // Check cooldown
    const lastSent = this.cooldowns.get(type);
    if (lastSent && Date.now() - lastSent < this.cooldownMs) {
      log.debug("alert suppressed (cooldown)", { type, message });
      return;
    }

    // Always log locally
    if (severity === "critical") {
      log.error(`ALERT [${type}]: ${message}`, data);
    } else {
      log.warn(`ALERT [${type}]: ${message}`, data);
    }

    // Send webhook if configured
    if (this.webhookUrl) {
      try {
        await this._sendWebhook(entry);
        entry.sent = true;
        this.cooldowns.set(type, Date.now());
      } catch (err) {
        log.error("webhook delivery failed", { error: err.message, type });
      }
    }

    this.cooldowns.set(type, Date.now());
  }

  async _sendWebhook(entry) {
    let body;

    if (this.webhookType === "slack") {
      const emoji = entry.severity === "critical" ? "🚨" : "⚠️";
      body = {
        text: `${emoji} *OpenClaw Alert* — ${entry.type}`,
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: `${emoji} *${entry.type}*\n${entry.message}` },
          },
          ...(Object.keys(entry.data).length > 0
            ? [{
              type: "context",
              elements: [{ type: "mrkdwn", text: `\`\`\`${JSON.stringify(entry.data, null, 2)}\`\`\`` }],
            }]
            : []),
        ],
      };
    } else if (this.webhookType === "discord") {
      const color = entry.severity === "critical" ? 0xff0000 : 0xffaa00;
      body = {
        embeds: [{
          title: `OpenClaw Alert: ${entry.type}`,
          description: entry.message,
          color,
          timestamp: entry.timestamp,
          fields: Object.entries(entry.data).map(([k, v]) => ({
            name: k,
            value: String(v),
            inline: true,
          })),
        }],
      };
    } else {
      body = entry;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      await fetch(this.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Get recent alert history. */
  getHistory() {
    return [...this.history];
  }

  /** Check if alerting is configured. */
  isConfigured() {
    return Boolean(this.webhookUrl);
  }
}

// Singleton
export const alerts = new AlertManager();
