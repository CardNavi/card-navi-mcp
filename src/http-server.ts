#!/usr/bin/env node

/**
 * Card Wize MCP Server — Streamable HTTP Transport
 * With telemetry logging for exposure tracking & card-company reporting.
 */

import type { Request, Response, NextFunction } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { createServer } from "./server.js";
import { getDb, closeDb } from "./db/connection.js";
import {
  initTelemetrySchema,
  hashIp,
  detectClient,
  parseToolCall,
  extractCardIds,
  insertLog,
  rebuildDailyStats,
  getOverviewStats,
  getCardExposure,
} from "./db/telemetry.js";

const PORT = parseInt(process.env.PORT ?? "3002", 10);
const HOST = process.env.CARD_HOST ?? "0.0.0.0";
const STATS_API_KEY = process.env.STATS_API_KEY; // optional: protect /stats

// Initialize telemetry tables
const db = getDb();
initTelemetrySchema(db);

const app = createMcpExpressApp({ host: HOST });

// ---------------------------------------------------------------------------
// Health check (also update card count from DB)
// ---------------------------------------------------------------------------

app.get("/health", (_req: Request, res: Response) => {
  const count = (db.prepare("SELECT COUNT(*) as c FROM cards").get() as { c: number }).c;
  res.json({
    status: "ok",
    service: "card-wize",
    version: "0.2.0",
    transport: "streamable-http",
    cards: count,
  });
});

// ---------------------------------------------------------------------------
// MCP endpoint with telemetry middleware
// ---------------------------------------------------------------------------

app.post("/mcp", async (req: Request, res: Response) => {
  const startTime = Date.now();
  const sessionId =
    (req.headers["mcp-session-id"] as string) ?? null;
  const userAgent = req.headers["user-agent"] as string | undefined;
  const clientIp =
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ??
    req.socket.remoteAddress;
  const clientType = detectClient(userAgent);
  const ipHash = hashIp(clientIp);

  // Parse tool call from JSON-RPC body
  const { toolName, params } = parseToolCall(req.body);

  // Capture response body for card ID extraction
  const originalJson = res.json.bind(res);
  let capturedBody: unknown = null;
  res.json = (body: unknown) => {
    capturedBody = body;
    return originalJson(body);
  };

  // After response is sent, log telemetry
  res.on("finish", () => {
    const responseMs = Date.now() - startTime;

    // Extract card IDs from response
    let cardIds: string[] = [];
    let resultCount = 0;
    try {
      const bodyStr = typeof capturedBody === "string"
        ? capturedBody
        : JSON.stringify(capturedBody ?? "");
      cardIds = extractCardIds(bodyStr);
      resultCount = cardIds.length;
    } catch { /* ignore */ }

    insertLog(db, {
      sessionId,
      ipHash,
      userAgent,
      clientType,
      toolName,
      params,
      responseMs,
      cardIds,
      resultCount,
    });
  });

  // Actual MCP handling
  const server = createServer();
  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);

    res.on("close", () => {
      transport.close();
      server.close();
    });
  } catch (error) {
    console.error("Error handling MCP request:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

app.get("/mcp", (_req: Request, res: Response) => {
  res.writeHead(405).end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    })
  );
});

app.delete("/mcp", (_req: Request, res: Response) => {
  res.writeHead(405).end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    })
  );
});

// ---------------------------------------------------------------------------
// Stats API — for card company reporting
// ---------------------------------------------------------------------------

function statsAuth(req: Request, res: Response, next: NextFunction): void {
  if (!STATS_API_KEY) { next(); return; }
  const key = req.headers["x-api-key"] ?? req.query.key;
  if (key !== STATS_API_KEY) {
    res.status(401).json({ error: "Invalid API key" });
    return;
  }
  next();
}

// Overview dashboard
app.get("/stats", statsAuth, (_req: Request, res: Response) => {
  const days = parseInt((_req.query.days as string) ?? "30", 10);
  rebuildDailyStats(db);
  res.json(getOverviewStats(db, days));
});

// Per-card exposure report (the ¥10万/月 product)
app.get("/stats/card/:cardId", statsAuth, (req: Request, res: Response) => {
  const days = parseInt((req.query.days as string) ?? "30", 10);
  rebuildDailyStats(db);
  const cardId = Array.isArray(req.params.cardId) ? req.params.cardId[0] : req.params.cardId;
  const report = getCardExposure(db, cardId, days);
  if (!report) {
    res.status(404).json({ error: "Card not found" });
    return;
  }
  res.json(report);
});

// Top cards by exposure (share of voice ranking)
app.get("/stats/ranking", statsAuth, (_req: Request, res: Response) => {
  const days = parseInt((_req.query.days as string) ?? "30", 10);
  const limit = parseInt((_req.query.limit as string) ?? "20", 10);
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceStr = since.toISOString().substring(0, 10);

  rebuildDailyStats(db);

  const ranking = db.prepare(`
    SELECT e.card_id, c.card_name, c.issuer,
           SUM(e.exposure_count) as total_exposure,
           SUM(e.top3_count) as top3,
           SUM(e.top1_count) as top1
    FROM mcp_card_exposure e
    JOIN cards c ON c.card_id = e.card_id
    WHERE e.date >= ?
    GROUP BY e.card_id
    ORDER BY total_exposure DESC
    LIMIT ?
  `).all(sinceStr, limit);

  res.json({ period: { since: sinceStr, days }, ranking });
});

// Context-level analysis (what stores/categories are queried)
app.get("/stats/contexts", statsAuth, (_req: Request, res: Response) => {
  const days = parseInt((_req.query.days as string) ?? "30", 10);
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceStr = since.toISOString().substring(0, 10);

  const contexts = db.prepare(`
    SELECT params_json
    FROM mcp_request_log
    WHERE date(timestamp) >= ?
      AND tool_name IN ('recommend_card', 'search_cards')
      AND params_json IS NOT NULL
  `).all(sinceStr) as Array<{ params_json: string }>;

  // Aggregate store/category mentions
  const storeCounts = new Map<string, number>();
  const categoryCounts = new Map<string, number>();

  for (const row of contexts) {
    try {
      const p = JSON.parse(row.params_json);
      if (p.store) storeCounts.set(p.store, (storeCounts.get(p.store) ?? 0) + 1);
      if (p.category) categoryCounts.set(p.category, (categoryCounts.get(p.category) ?? 0) + 1);
      if (p.query) storeCounts.set(p.query, (storeCounts.get(p.query) ?? 0) + 1);
    } catch { /* skip */ }
  }

  const sortMap = (m: Map<string, number>) =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));

  res.json({
    period: { since: sinceStr, days },
    stores: sortMap(storeCounts),
    categories: sortMap(categoryCounts),
  });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(
    `Card Wize MCP Server (HTTP) listening on http://${HOST}:${PORT}/mcp`
  );
  console.log(`Health check: http://${HOST}:${PORT}/health`);
  console.log(`Stats API:    http://${HOST}:${PORT}/stats`);
}).on("error", (error: Error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});

process.on("SIGINT", () => {
  console.log("Shutting down...");
  closeDb();
  process.exit(0);
});
process.on("SIGTERM", () => {
  closeDb();
  process.exit(0);
});
