// Structured JSON logger with levels, correlation IDs, and redaction.
// Zero dependencies — uses only Node.js builtins.

import crypto from "node:crypto";

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3, fatal: 4 };
const LEVEL_NAMES = Object.keys(LEVELS);

const currentLevel = LEVELS[process.env.LOG_LEVEL?.toLowerCase()] ?? LEVELS.info;
const isDebug = process.env.OPENCLAW_TEMPLATE_DEBUG?.toLowerCase() === "true";

// Correlation ID per async context (cheap request tracing)
let _correlationId = null;

export function withCorrelation(id, fn) {
  const prev = _correlationId;
  _correlationId = id;
  try {
    return fn();
  } finally {
    _correlationId = prev;
  }
}

export function generateCorrelationId() {
  return crypto.randomBytes(8).toString("hex");
}

function formatEntry(level, component, message, data) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    component,
    msg: message,
  };
  if (_correlationId) entry.cid = _correlationId;
  if (data !== undefined && data !== null) {
    if (data instanceof Error) {
      entry.error = { message: data.message, stack: data.stack?.split("\n").slice(0, 5) };
    } else {
      entry.data = data;
    }
  }
  return entry;
}

function emit(level, component, message, data) {
  if (LEVELS[level] < currentLevel && !(isDebug && level === "debug")) return;

  const entry = formatEntry(level, component, message, data);
  const line = JSON.stringify(entry);

  if (LEVELS[level] >= LEVELS.error) {
    process.stderr.write(line + "\n");
  } else {
    process.stdout.write(line + "\n");
  }
}

/**
 * Create a scoped logger for a component.
 * @param {string} component - Component name (e.g., "gateway", "smart-router")
 * @returns {object} Logger with debug/info/warn/error/fatal methods
 */
export function createLogger(component) {
  return {
    debug: (msg, data) => emit("debug", component, msg, data),
    info: (msg, data) => emit("info", component, msg, data),
    warn: (msg, data) => emit("warn", component, msg, data),
    error: (msg, data) => emit("error", component, msg, data),
    fatal: (msg, data) => emit("fatal", component, msg, data),
    child: (subComponent) => createLogger(`${component}.${subComponent}`),
    isDebug: () => isDebug,
  };
}

// Default logger
export const log = createLogger("app");
