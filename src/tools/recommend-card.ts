import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";

const APP_BASE_URL = "https://card-navi.app";

const RecommendInput = z.object({
  store: z
    .string()
    .optional()
    .describe(
      "Store or merchant name, e.g. 'コンビニ', 'Amazon', 'マクドナルド', 'スタバ', 'ENEOS'"
    ),
  category: z
    .string()
    .optional()
    .describe(
      "Spending category: コンビニ, EC, 飲食, 旅行, 交通, ガソリン, 百貨店, スーパー, etc."
    ),
  annual_fee_max: z
    .number()
    .optional()
    .describe("Max annual fee in yen (0 = free only)"),
  limit: z
    .number()
    .min(1)
    .max(10)
    .default(3)
    .describe("Max recommendations (default: 3)"),
});

interface RewardMatch {
  card_id: string;
  card_name: string;
  issuer: string | null;
  brand: string | null;
  annual_fee: number | null;
  annual_fee_text: string | null;
  base_reward_rate: number | null;
  point_program: string | null;
  store_name: string;
  category: string | null;
  reward_rate: number;
  condition: string | null;
}

// Store name aliases for flexible matching
const STORE_ALIASES: Record<string, string[]> = {
  コンビニ: ["セブンイレブン", "ファミリーマート", "ローソン", "コンビニ"],
  amazon: ["Amazon", "amazon"],
  楽天: ["楽天市場", "楽天"],
  スタバ: ["スターバックス", "スタバ"],
  マック: ["マクドナルド", "マック"],
  starbucks: ["スターバックス"],
  mcdonalds: ["マクドナルド"],
  ガソリン: ["ENEOS", "出光", "コスモ石油", "ガソリン"],
  スーパー: ["イオン", "イトーヨーカドー", "西友", "スーパー"],
};

export function register(server: McpServer, db: Database.Database): void {
  server.tool(
    "recommend_card",
    "Find the best credit card for a specific store or spending category. Shows which card gives the highest reward rate at that merchant. Covers 189 cards × 553 store-specific reward rules. For real-time promo alerts and Chrome extension auto-detection → Card Navi app.",
    RecommendInput.shape,
    async ({ store, category, annual_fee_max, limit }) => {
      if (!store && !category) {
        return {
          content: [
            {
              type: "text" as const,
              text: "店舗名 (store) または利用カテゴリ (category) を指定してください。\n例: store='マクドナルド', category='コンビニ'",
            },
          ],
        };
      }

      const searchTerms = resolveSearchTerms(store, category);
      const results = findBestCards(db, searchTerms, annual_fee_max, limit);

      if (results.length === 0) {
        // Fallback: show cards with highest base rate
        const fallback = db
          .prepare(
            `SELECT card_id, card_name, issuer, brand, annual_fee, annual_fee_text,
                    base_reward_rate, point_program
             FROM cards
             WHERE base_reward_rate IS NOT NULL
             ${annual_fee_max !== undefined ? "AND (annual_fee IS NULL OR annual_fee <= ?)" : ""}
             ORDER BY base_reward_rate DESC LIMIT ?`
          )
          .all(
            ...(annual_fee_max !== undefined
              ? [annual_fee_max, limit]
              : [limit])
          ) as Array<{
          card_id: string;
          card_name: string;
          base_reward_rate: number;
          annual_fee: number;
        }>;

        const target = store ?? category ?? "";
        const lines = [
          `💳 「${target}」の専用還元データはありませんが、基本還元率が高いカードをおすすめします:\n`,
        ];
        for (const [i, c] of fallback.entries()) {
          const feeStr = c.annual_fee === 0 ? "無料" : `${c.annual_fee?.toLocaleString()}円`;
          lines.push(
            `${i + 1}. **${c.card_name}** — 基本 ${c.base_reward_rate}%（年会費${feeStr}）`
          );
          lines.push(`   🔗 ${APP_BASE_URL}/card/${c.card_id}`);
        }
        lines.push(`\n🔗 店舗別のリアルタイム還元率は Card Navi アプリで → ${APP_BASE_URL}`);

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
        };
      }

      const target = store ?? category ?? "";
      const lines = [
        `💳 「${target}」で最もお得なカード（${results.length}件）\n`,
      ];

      for (const [i, r] of results.entries()) {
        const feeStr =
          r.annual_fee === 0
            ? "年会費無料"
            : r.annual_fee
              ? `年会費${r.annual_fee.toLocaleString()}円`
              : "";
        const feeNote = r.annual_fee_text ? `（${r.annual_fee_text}）` : "";

        lines.push(`### ${i + 1}. ${r.card_name} — **${r.reward_rate}%還元**`);
        lines.push(`   ${r.issuer ?? ""} ｜ ${r.brand ?? ""}`);
        lines.push(`   対象: ${r.store_name}`);
        if (r.condition) lines.push(`   条件: ${r.condition}`);
        lines.push(`   ${[feeStr + feeNote, r.point_program ? `💰 ${r.point_program}` : ""].filter(Boolean).join(" ｜ ")}`);
        lines.push(`   🔗 ${APP_BASE_URL}/card/${r.card_id}`);
        lines.push("");
      }

      lines.push(`---`);
      lines.push(
        `🔗 マイカード登録で「今この店で使うべきカード」を自動判定 → ${APP_BASE_URL}`
      );
      lines.push(
        `💡 Card Navi Chrome拡張なら、ECサイトで最適カードを自動表示します`
      );

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    }
  );
}

function resolveSearchTerms(
  store: string | undefined,
  category: string | undefined
): string[] {
  const terms: string[] = [];

  if (store) {
    const lower = store.toLowerCase();
    for (const [alias, targets] of Object.entries(STORE_ALIASES)) {
      if (lower === alias || lower.includes(alias)) {
        terms.push(...targets);
      }
    }
    if (terms.length === 0) terms.push(store);
  }

  if (category) {
    for (const [alias, targets] of Object.entries(STORE_ALIASES)) {
      if (category === alias || category.includes(alias)) {
        terms.push(...targets);
      }
    }
    if (!terms.some((t) => t === category)) terms.push(category);
  }

  return [...new Set(terms)];
}

function findBestCards(
  db: Database.Database,
  terms: string[],
  feeMax: number | undefined,
  limit: number
): RewardMatch[] {
  if (terms.length === 0) return [];

  const likeClauses = terms.map((_, i) => `(r.store_name LIKE @t${i} OR r.category LIKE @t${i})`);
  const params: Record<string, unknown> = {};
  terms.forEach((t, i) => {
    params[`t${i}`] = `%${t}%`;
  });

  let sql = `
    SELECT c.card_id, c.card_name, c.issuer, c.brand, c.annual_fee,
           c.annual_fee_text, c.base_reward_rate, c.point_program,
           r.store_name, r.category, r.reward_rate, r.condition
    FROM reward_rates r
    JOIN cards c ON c.card_id = r.card_id
    WHERE (${likeClauses.join(" OR ")})
  `;

  if (feeMax !== undefined) {
    sql += ` AND (c.annual_fee IS NULL OR c.annual_fee <= @fee_max)`;
    params.fee_max = feeMax;
  }

  sql += ` ORDER BY r.reward_rate DESC LIMIT @limit`;
  params.limit = limit;

  return db.prepare(sql).all(params) as RewardMatch[];
}
