#!/usr/bin/env node

/**
 * CardNavi MCP Server — stdio transport
 *
 * Credit card optimizer for 189 Japanese cards.
 * Search, store-specific recommendations, card details, side-by-side comparison.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { closeDb } from "./db/connection.js";

const server = createServer();
const transport = new StdioServerTransport();

await server.connect(transport);
console.error("CardNavi MCP Server running on stdio");

process.on("SIGINT", () => {
  closeDb();
  process.exit(0);
});
process.on("SIGTERM", () => {
  closeDb();
  process.exit(0);
});
