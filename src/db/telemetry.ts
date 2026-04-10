/**
 * MCP Telemetry — request/response logging for Card Wize MCP server.
 *
 * Captures: tool calls, parameters (store/category), returned card IDs,
 * client type (Claude/ChatGPT/Cursor), session ID, timing.
 *
 * Zero PII: IP is hashed, no user identifiers stored.
 */

import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export function initTelemetrySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mcp_request_log (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp     TEXT NOT NULL DEFAULT (datetime('now')),
      session_id    TEXT,
      ip_hash       TEXT,
      user_agent    TEXT,
      client_type   TEXT,        -- 'claude' | 'chatgpt' | 'cursor' | 'other'
      tool_name     TEXT,        -- 'recommend_card' | 'search_cards' | etc.
      params_json   TEXT,        -- tool input params (store, category, etc.)
      response_ms   INTEGER,     -- response time in ms
      card_ids_json TEXT,        -- array of card_ids returned in response
      result_count  INTEGER      -- number of results returned
    );

    CREATE INDEX IF NOT EXISTS idx_log_timestamp ON mcp_request_log(timestamp);
    CREATE INDEX IF NOT EXISTS idx_log_tool ON mcp_request_log(tool_name);
    CREATE INDEX IF NOT EXISTS idx_log_client ON mcp_request_log(client_type);
    CREATE INDEX IF NOT EXISTS idx_log_session ON mcp_request_log(session_id);

    -- Materialized daily aggregates (rebuilt by /stats or cron)
    CREATE TABLE IF NOT EXISTS mcp_daily_stats (
      date          TEXT NOT NULL,
      tool_name     TEXT NOT NULL,
      client_type   TEXT NOT NULL,
      query_count   INTEGER NOT NULL DEFAULT 0,
      unique_sessions INTEGER NOT NULL DEFAULT 0,
      avg_response_ms REAL,
      PRIMARY KEY (date, tool_name, client_type)
    );

    -- Card-level exposure tracking
    CREATE TABLE IF NOT EXISTS mcp_card_exposure (
      date          TEXT NOT NULL,
      card_id       TEXT NOT NULL,
      tool_name     TEXT NOT NULL,
      exposure_count INTEGER NOT NULL DEFAULT 0,
      top3_count    INTEGER NOT NULL DEFAULT 0,  -- times appeared in top 3
      top1_count    INTEGER NOT NULL DEFAULT 0,  -- times appeared as #1
      PRIMARY KEY (date, card_id, tool_name)
    );

    CREATE INDEX IF NOT EXISTS idx_exposure_card ON mcp_card_exposure(card_id);
    CREATE INDEX IF NOT EXISTS idx_exposure_date ON mcp_card_exposure(date);
  `);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function hashIp(ip: string | undefined): string {
  if (!ip) return "unknown";
  return createHash("sha256")
    .update(ip + (process.env.IP_HASH_SALT ?? "card-wize-salt"))
    .digest("hex")
    .substring(0, 16);
}

export function detectClient(ua: string | undefined): string {
  if (!ua) return "unknown";
  const lower = ua.toLowerCase();
  if (lower.includes("claude") || lower.includes("anthropic")) return "claude";
  if (lower.includes("chatgpt") || lower.includes("openai")) return "chatgpt";
  if (lower.includes("cursor")) return "cursor";
  if (lower.includes("windsurf")) return "windsurf";
  if (lower.includes("gemini") || lower.includes("google")) return "gemini";
  if (lower.includes("perplexity")) return "perplexity";
  return "other";
}

/**
 * Extract card_ids from MCP tool response text.
 * Looks for patterns like `/card/some_card_id` in the markdown output.
 */
export function extractCardIds(responseText: string): string[] {
  const matches = responseText.matchAll(/\/card\/([a-zA-Z0-9_-]+)/g);
  return [...new Set([...matches].map((m) => m[1]))];
}

/**
 * Extract tool name and params from JSON-RPC request body.
 */
export function parseToolCall(body: unknown): {
  toolName: string | null;
  params: Record<string, unknown> | null;
  id: unknown;
} {
  if (!body || typeof body !== "object") return { toolName: null, params: null, id: null };
  const obj = body as Record<string, unknown>;

  // JSON-RPC: method = "tools/call", params.name = tool name
  if (obj.method === "tools/call" && obj.params && typeof obj.params === "object") {
    const p = obj.params as Record<string, unknown>;
    return {
      toolName: typeof p.name === "string" ? p.name : null,
      params: p.arguments && typeof p.arguments === "object"
        ? (p.arguments as Record<string, unknown>)
        : null,
      id: obj.id,
    };
  }

  return { toolName: null, params: null, id: obj.id };
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

export interface LogEntry {
  sessionId: string | null;
  ipHash: string;
  userAgent: string | undefined;
  clientType: string;
  toolName: string | null;
  params: Record<string, unknown> | null;
  responseMs: number;
  cardIds: string[];
  resultCount: number;
}

export function insertLog(db: Database.Database, entry: LogEntry): void {
  try {
    db.prepare(`
      INSERT INTO mcp_request_log
        (session_id, ip_hash, user_agent, client_type, tool_name,
         params_json, response_ms, card_ids_json, result_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.sessionId,
      entry.ipHash,
      entry.userAgent?.substring(0, 500) ?? null,
      entry.clientType,
      entry.toolName,
      entry.params ? JSON.stringify(entry.params) : null,
      entry.responseMs,
      entry.cardIds.length > 0 ? JSON.stringify(entry.cardIds) : null,
      entry.resultCount,
    );
  } catch (err) {
    console.error("[telemetry] Failed to insert log:", err);
  }
}

// ---------------------------------------------------------------------------
// Aggregation (called by /stats endpoint or daily cron)
// ---------------------------------------------------------------------------

export function rebuildDailyStats(db: Database.Database, date?: string): void {
  const targetDate = date ?? new Date().toISOString().substring(0, 10);

  db.transaction(() => {
    // Daily stats
    db.prepare(`DELETE FROM mcp_daily_stats WHERE date = ?`).run(targetDate);
    db.prepare(`
      INSERT INTO mcp_daily_stats (date, tool_name, client_type, query_count, unique_sessions, avg_response_ms)
      SELECT
        date(timestamp) as date,
        COALESCE(tool_name, 'non-tool') as tool_name,
        COALESCE(client_type, 'unknown') as client_type,
        COUNT(*) as query_count,
        COUNT(DISTINCT session_id) as unique_sessions,
        AVG(response_ms) as avg_response_ms
      FROM mcp_request_log
      WHERE date(timestamp) = ?
      GROUP BY date(timestamp), tool_name, client_type
    `).run(targetDate);

    // Card exposure
    db.prepare(`DELETE FROM mcp_card_exposure WHERE date = ?`).run(targetDate);

    // Extract card exposures from logs
    const logs = db.prepare(`
      SELECT tool_name, card_ids_json
      FROM mcp_request_log
      WHERE date(timestamp) = ? AND card_ids_json IS NOT NULL
    `).all(targetDate) as Array<{ tool_name: string; card_ids_json: string }>;

    const exposureMap = new Map<string, { exposure: number; top3: number; top1: number }>();

    for (const log of logs) {
      try {
        const cardIds: string[] = JSON.parse(log.card_ids_json);
        for (const [idx, cardId] of cardIds.entries()) {
          const key = `${cardId}:${log.tool_name}`;
          const cur = exposureMap.get(key) ?? { exposure: 0, top3: 0, top1: 0 };
          cur.exposure++;
          if (idx < 3) cur.top3++;
          if (idx === 0) cur.top1++;
          exposureMap.set(key, cur);
        }
      } catch { /* skip malformed */ }
    }

    const insert = db.prepare(`
      INSERT INTO mcp_card_exposure (date, card_id, tool_name, exposure_count, top3_count, top1_count)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (const [key, val] of exposureMap) {
      const [cardId, toolName] = key.split(":");
      insert.run(targetDate, cardId, toolName, val.exposure, val.top3, val.top1);
    }
  })();
}

// ---------------------------------------------------------------------------
// Query helpers for /stats endpoints
// ---------------------------------------------------------------------------

export interface OverviewStats {
  totalQueries: number;
  uniqueSessions: number;
  avgResponseMs: number;
  clientBreakdown: Array<{ client_type: string; count: number; pct: number }>;
  toolBreakdown: Array<{ tool_name: string; count: number; pct: number }>;
  dailyTrend: Array<{ date: string; queries: number }>;
}

export function getOverviewStats(db: Database.Database, days: number = 30): OverviewStats {
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceStr = since.toISOString().substring(0, 10);

  const totals = db.prepare(`
    SELECT COUNT(*) as total, COUNT(DISTINCT session_id) as sessions,
           AVG(response_ms) as avg_ms
    FROM mcp_request_log WHERE date(timestamp) >= ?
  `).get(sinceStr) as { total: number; sessions: number; avg_ms: number };

  const clients = db.prepare(`
    SELECT client_type, COUNT(*) as count
    FROM mcp_request_log WHERE date(timestamp) >= ?
    GROUP BY client_type ORDER BY count DESC
  `).all(sinceStr) as Array<{ client_type: string; count: number }>;

  const tools = db.prepare(`
    SELECT tool_name, COUNT(*) as count
    FROM mcp_request_log WHERE date(timestamp) >= ? AND tool_name IS NOT NULL
    GROUP BY tool_name ORDER BY count DESC
  `).all(sinceStr) as Array<{ tool_name: string; count: number }>;

  const daily = db.prepare(`
    SELECT date(timestamp) as date, COUNT(*) as queries
    FROM mcp_request_log WHERE date(timestamp) >= ?
    GROUP BY date(timestamp) ORDER BY date
  `).all(sinceStr) as Array<{ date: string; queries: number }>;

  const total = totals.total || 1;

  return {
    totalQueries: totals.total,
    uniqueSessions: totals.sessions,
    avgResponseMs: Math.round(totals.avg_ms ?? 0),
    clientBreakdown: clients.map((c) => ({
      ...c,
      pct: Math.round((c.count / total) * 100),
    })),
    toolBreakdown: tools.map((t) => ({
      ...t,
      pct: Math.round((t.count / total) * 100),
    })),
    dailyTrend: daily,
  };
}

export interface CardExposureReport {
  cardId: string;
  cardName: string;
  totalExposure: number;
  top3Count: number;
  top1Count: number;
  top3Rate: number;
  shareOfVoice: number;
  byTool: Array<{ tool_name: string; exposure: number }>;
  dailyTrend: Array<{ date: string; exposure: number }>;
}

export function getCardExposure(
  db: Database.Database,
  cardId: string,
  days: number = 30,
): CardExposureReport | null {
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceStr = since.toISOString().substring(0, 10);

  const card = db.prepare(`SELECT card_name FROM cards WHERE card_id = ?`).get(cardId) as
    | { card_name: string }
    | undefined;
  if (!card) return null;

  const totals = db.prepare(`
    SELECT SUM(exposure_count) as exposure, SUM(top3_count) as top3, SUM(top1_count) as top1
    FROM mcp_card_exposure WHERE card_id = ? AND date >= ?
  `).get(cardId, sinceStr) as { exposure: number; top3: number; top1: number };

  const totalAllExposure = (db.prepare(`
    SELECT SUM(exposure_count) as total
    FROM mcp_card_exposure WHERE date >= ?
  `).get(sinceStr) as { total: number }).total || 1;

  const byTool = db.prepare(`
    SELECT tool_name, SUM(exposure_count) as exposure
    FROM mcp_card_exposure WHERE card_id = ? AND date >= ?
    GROUP BY tool_name ORDER BY exposure DESC
  `).all(cardId, sinceStr) as Array<{ tool_name: string; exposure: number }>;

  const daily = db.prepare(`
    SELECT date, SUM(exposure_count) as exposure
    FROM mcp_card_exposure WHERE card_id = ? AND date >= ?
    GROUP BY date ORDER BY date
  `).all(cardId, sinceStr) as Array<{ date: string; exposure: number }>;

  const exposure = totals.exposure ?? 0;
  const top3 = totals.top3 ?? 0;

  return {
    cardId,
    cardName: card.card_name,
    totalExposure: exposure,
    top3Count: top3,
    top1Count: totals.top1 ?? 0,
    top3Rate: exposure > 0 ? Math.round((top3 / exposure) * 100) : 0,
    shareOfVoice: Math.round((exposure / totalAllExposure) * 1000) / 10,
    byTool,
    dailyTrend: daily,
  };
}
