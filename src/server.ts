import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDb } from "./db/connection.js";
import { initSchema } from "./db/schema.js";

import { register as registerSearchCards } from "./tools/search-cards.js";
import { register as registerRecommendCard } from "./tools/recommend-card.js";
import { register as registerGetCardDetail } from "./tools/get-card-detail.js";
import { register as registerCompareCards } from "./tools/compare-cards.js";

export function createServer(): McpServer {
  const server = new McpServer({
    name: "card-navi",
    version: "0.1.0",
  });

  const db = getDb();
  initSchema(db);

  registerSearchCards(server, db);
  registerRecommendCard(server, db);
  registerGetCardDetail(server, db);
  registerCompareCards(server, db);

  return server;
}
