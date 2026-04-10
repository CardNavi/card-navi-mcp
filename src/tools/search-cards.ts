import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";

const APP_BASE_URL = "https://card-nabi.vercel.app";

const SearchInput = z.object({
  query: z
    .string()
    .describe(
      "Search query — card name, issuer, brand (VISA/JCB/Mastercard/Amex), point program, or keyword. Supports Japanese."
    ),
  annual_fee_max: z
    .number()
    .optional()
    .describe("Maximum annual fee in yen (0 = free cards only)"),
  min_reward_rate: z
    .number()
    .optional()
    .describe("Minimum base reward rate (e.g. 1.0 for 1%+)"),
  limit: z
    .number()
    .min(1)
    .max(20)
    .default(5)
    .describe("Max results (default: 5)"),
});

interface CardRow {
  card_id: string;
  card_name: string;
  issuer: string | null;
  brand: string | null;
  annual_fee: number | null;
  annual_fee_text: string | null;
  base_reward_rate: number | null;
  point_program: string | null;
  electronic_money: string | null;
  apple_pay: number;
  google_pay: number;
  touch_payment: string | null;
}

export function register(server: McpServer, db: Database.Database): void {
  server.tool(
    "search_cards",
    "Search 200+ Japanese credit cards by name, issuer, brand, or features. Filter by annual fee and reward rate. Returns card specs and top reward categories. For personalized card management and promo calendar → Card Wize app.",
    SearchInput.shape,
    async ({ query, annual_fee_max, min_reward_rate, limit }) => {
      let results = ftsSearch(db, query, annual_fee_max, min_reward_rate, limit);

      if (results.length === 0) {
        results = likeSearch(db, query, annual_fee_max, min_reward_rate, limit);
      }

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `「${query}」に該当するカードが見つかりませんでした。\n\n🔗 全カード検索は Card Wize アプリで → ${APP_BASE_URL}`,
            },
          ],
        };
      }

      const formatted = results.map((r, i) => formatCard(db, r, i + 1));

      return {
        content: [
          {
            type: "text" as const,
            text: [
              `💳 「${query}」の検索結果（${results.length}件）\n`,
              ...formatted,
              `---`,
              `🔗 カード比較・マイカード管理は Card Wize アプリで → ${APP_BASE_URL}`,
            ].join("\n"),
          },
        ],
      };
    }
  );
}

function ftsSearch(
  db: Database.Database,
  query: string,
  feeMax: number | undefined,
  minRate: number | undefined,
  limit: number
): CardRow[] {
  const ftsQuery = query.replace(/['"*(){}[\]^~\\]/g, "").trim();
  if (!ftsQuery) return [];

  let sql = `
    SELECT c.card_id, c.card_name, c.issuer, c.brand, c.annual_fee,
           c.annual_fee_text, c.base_reward_rate, c.point_program,
           c.electronic_money, c.apple_pay, c.google_pay, c.touch_payment
    FROM cards_fts f
    JOIN cards c ON c.card_id = f.card_id
    WHERE cards_fts MATCH @query
  `;
  const params: Record<string, unknown> = { query: ftsQuery };

  if (feeMax !== undefined) {
    sql += ` AND (c.annual_fee IS NULL OR c.annual_fee <= @fee_max)`;
    params.fee_max = feeMax;
  }
  if (minRate !== undefined) {
    sql += ` AND c.base_reward_rate >= @min_rate`;
    params.min_rate = minRate;
  }

  sql += ` ORDER BY c.base_reward_rate DESC LIMIT @limit`;
  params.limit = limit;

  try {
    return db.prepare(sql).all(params) as CardRow[];
  } catch {
    return [];
  }
}

function likeSearch(
  db: Database.Database,
  query: string,
  feeMax: number | undefined,
  minRate: number | undefined,
  limit: number
): CardRow[] {
  const like = `%${query}%`;
  let sql = `
    SELECT card_id, card_name, issuer, brand, annual_fee, annual_fee_text,
           base_reward_rate, point_program, electronic_money,
           apple_pay, google_pay, touch_payment
    FROM cards
    WHERE (card_name LIKE @like OR issuer LIKE @like OR brand LIKE @like
           OR point_program LIKE @like OR electronic_money LIKE @like)
  `;
  const params: Record<string, unknown> = { like };

  if (feeMax !== undefined) {
    sql += ` AND (annual_fee IS NULL OR annual_fee <= @fee_max)`;
    params.fee_max = feeMax;
  }
  if (minRate !== undefined) {
    sql += ` AND base_reward_rate >= @min_rate`;
    params.min_rate = minRate;
  }

  sql += ` ORDER BY base_reward_rate DESC LIMIT @limit`;
  params.limit = limit;

  return db.prepare(sql).all(params) as CardRow[];
}

function formatCard(db: Database.Database, c: CardRow, rank: number): string {
  const feeStr =
    c.annual_fee === 0
      ? "年会費無料"
      : c.annual_fee
        ? `年会費 ${c.annual_fee.toLocaleString()}円`
        : "";
  const feeNote = c.annual_fee_text ? `（${c.annual_fee_text}）` : "";
  const rateStr = c.base_reward_rate ? `基本還元率 ${c.base_reward_rate}%` : "";

  // Get top reward rates for this card
  const topRewards = db
    .prepare(
      `SELECT store_name, reward_rate, category FROM reward_rates
       WHERE card_id = ? ORDER BY reward_rate DESC LIMIT 3`
    )
    .all(c.card_id) as Array<{
    store_name: string;
    reward_rate: number;
    category: string;
  }>;

  const rewardLines = topRewards.map(
    (r) => `${r.store_name}: ${r.reward_rate}%`
  );

  const payments: string[] = [];
  if (c.apple_pay) payments.push("Apple Pay");
  if (c.google_pay) payments.push("Google Pay");
  if (c.touch_payment) payments.push(c.touch_payment);

  const lines = [
    `### ${rank}. ${c.card_name}`,
    `   ${c.issuer ?? ""} ｜ ${c.brand ?? ""}`,
    `   ${[feeStr + feeNote, rateStr].filter(Boolean).join(" ｜ ")}`,
  ];

  if (rewardLines.length > 0) {
    lines.push(`   🏆 高還元: ${rewardLines.join(", ")}`);
  }
  if (payments.length > 0) {
    lines.push(`   📱 ${payments.join(", ")}`);
  }
  if (c.point_program) {
    lines.push(`   💰 ${c.point_program}`);
  }
  lines.push(`   🔗 ${APP_BASE_URL}/card/${c.card_id}`);
  lines.push("");

  return lines.join("\n");
}
