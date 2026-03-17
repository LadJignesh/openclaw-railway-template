// Express routes for the Smart Router API.
// Mount under /setup/api/smart-router/* (protected by SETUP_PASSWORD auth).

import { SmartRouter } from "./index.js";

let router = null;

function getRouter() {
  if (!router) router = new SmartRouter();
  return router;
}

export function getSmartRouterInstance() {
  return getRouter();
}

/**
 * Register smart-router API endpoints on an Express app.
 * @param {import("express").Application} app
 */
export function registerSmartRouterRoutes(app) {
  // Status
  app.get("/setup/api/smart-router/status", (_req, res) => {
    try {
      const status = getRouter().getStatus();
      res.json({ ok: true, ...status });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Classify (dry run)
  app.post("/setup/api/smart-router/classify", (req, res) => {
    try {
      const { description, content, hasImage, priority } = req.body || {};
      if (!description && !content) {
        return res.status(400).json({ ok: false, error: "description or content required" });
      }
      const result = getRouter().classifyOnly({ description, content, hasImage, priority });
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Execute task
  app.post("/setup/api/smart-router/run", async (req, res) => {
    try {
      const task = req.body;
      if (!task || (!task.description && !task.content && !task.messages)) {
        return res.status(400).json({ ok: false, error: "task description, content, or messages required" });
      }
      const result = await getRouter().process(task);
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Daily summary
  app.get("/setup/api/smart-router/summary", (req, res) => {
    try {
      const date = req.query.date || undefined;
      const summary = getRouter().getDailySummary(date);
      res.json({ ok: true, ...summary });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Model health + circuit breakers
  app.get("/setup/api/smart-router/model-stats", (_req, res) => {
    try {
      const stats = getRouter().getModelStats();
      const circuitBreakers = getRouter().getCircuitBreakers();
      res.json({ ok: true, models: stats, circuitBreakers });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Task logs
  app.get("/setup/api/smart-router/logs", (req, res) => {
    try {
      const date = req.query.date || undefined;
      const entries = getRouter().costTracker.getEntries(date);
      res.json({ ok: true, count: entries.length, entries });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  console.log("[smart-router] API routes registered at /setup/api/smart-router/*");
}
