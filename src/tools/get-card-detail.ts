import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";

const APP_BASE_URL = "https://card-nabi.vercel.app";

const DetailInput = z.object({
  card_id: z
    .string()
    .optional()
    .describe("Card ID (e.g. 'rakuten_standard', 'smbc_nl')"),
  name: z
    .string()
    .optional()
    .describe("Card name (e.g. '楽天カード', '三井住友カードNL')"),
});

interface CardDetail {
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
  min_age: number | null;
  url_official: string | null;
}

interface RewardRow {
  store_name: string;
  category: string | null;
  reward_rate: number;
  condition: string | null;
}

interface InsuranceRow {
  insurance_type: string;
  coverage: string | null;
  max_amount: string | null;
  condition: string | null;
}

interface SynergyRow {
  synergy_type: string;
  effect: string | null;
  annual_impact: string | null;
}

interface ExchangeRow {
  to_point: string;
  rate: string | null;
  efficiency: string | null;
}

export function register(server: McpServer, db: Database.Database): void {
  server.tool(
    "get_card_detail",
    "Get full details about a specific credit card — annual fee, reward rates by store, insurance, synergies, and point exchange routes. For promo calendar, spending tracker, and card application → Card Wize app.",
    DetailInput.shape,
    async ({ card_id, name }) => {
      if (!card_id && !name) {
        return {
          content: [
            {
              type: "text" as const,
              text: "card_id または name を指定してください。",
            },
          ],
        };
      }

      let card: CardDetail | undefined;

      if (card_id) {
        card = db
          .prepare("SELECT * FROM cards WHERE card_id = ?")
          .get(card_id) as CardDetail | undefined;
      }

      if (!card && name) {
        card = db
          .prepare("SELECT * FROM cards WHERE card_name = ?")
          .get(name) as CardDetail | undefined;
        if (!card) {
          card = db
            .prepare(
              "SELECT * FROM cards WHERE card_name LIKE ? LIMIT 1"
            )
            .get(`%${name}%`) as CardDetail | undefined;
        }
      }

      if (!card) {
        return {
          content: [
            {
              type: "text" as const,
              text: `「${card_id ?? name}」が見つかりませんでした。\n\n🔗 全カードは Card Wize アプリで → ${APP_BASE_URL}`,
            },
          ],
        };
      }

      const rewards = db
        .prepare(
          "SELECT store_name, category, reward_rate, condition FROM reward_rates WHERE card_id = ? ORDER BY reward_rate DESC"
        )
        .all(card.card_id) as RewardRow[];

      const insurance = db
        .prepare(
          "SELECT insurance_type, coverage, max_amount, condition FROM insurance WHERE card_id = ?"
        )
        .all(card.card_id) as InsuranceRow[];

      const synergies = db
        .prepare(
          "SELECT synergy_type, effect, annual_impact FROM synergies WHERE card_id = ?"
        )
        .all(card.card_id) as SynergyRow[];

      const exchanges = db
        .prepare(
          "SELECT to_point, rate, efficiency FROM point_exchanges WHERE card_id = ?"
        )
        .all(card.card_id) as ExchangeRow[];

      return {
        content: [
          {
            type: "text" as const,
            text: formatDetail(card, rewards, insurance, synergies, exchanges),
          },
        ],
      };
    }
  );
}

function formatDetail(
  c: CardDetail,
  rewards: RewardRow[],
  insurance: InsuranceRow[],
  synergies: SynergyRow[],
  exchanges: ExchangeRow[]
): string {
  const lines: string[] = [];

  // Header
  lines.push(`# 💳 ${c.card_name}`);
  lines.push("");
  lines.push(`| 項目 | 内容 |`);
  lines.push(`|------|------|`);
  lines.push(`| 発行元 | ${c.issuer ?? "—"} |`);
  lines.push(`| ブランド | ${c.brand ?? "—"} |`);

  const feeStr =
    c.annual_fee === 0
      ? "無料"
      : c.annual_fee !== null
        ? `${c.annual_fee.toLocaleString()}円`
        : "—";
  lines.push(
    `| 年会費 | ${feeStr}${c.annual_fee_text ? ` (${c.annual_fee_text})` : ""} |`
  );
  lines.push(
    `| 基本還元率 | ${c.base_reward_rate ? `${c.base_reward_rate}%` : "—"} |`
  );
  lines.push(`| ポイント | ${c.point_program ?? "—"} |`);

  const payments: string[] = [];
  if (c.apple_pay) payments.push("Apple Pay");
  if (c.google_pay) payments.push("Google Pay");
  if (c.electronic_money) payments.push(c.electronic_money);
  if (c.touch_payment) payments.push(c.touch_payment);
  if (payments.length > 0) {
    lines.push(`| 決済手段 | ${payments.join(", ")} |`);
  }
  if (c.min_age) lines.push(`| 申込年齢 | ${c.min_age}歳以上 |`);
  lines.push("");

  // Reward rates
  if (rewards.length > 0) {
    lines.push(`## 還元率一覧`);
    lines.push(`| 店舗/カテゴリ | 還元率 | 条件 |`);
    lines.push(`|-------------|--------|------|`);
    for (const r of rewards) {
      lines.push(
        `| ${r.store_name} | **${r.reward_rate}%** | ${r.condition ?? "—"} |`
      );
    }
    lines.push("");
  }

  // Insurance
  if (insurance.length > 0) {
    lines.push(`## 付帯保険`);
    for (const ins of insurance) {
      lines.push(
        `- **${ins.insurance_type}**: ${ins.coverage ?? ""} ${ins.max_amount ? `（最大${ins.max_amount}）` : ""} [${ins.condition ?? ""}]`
      );
    }
    lines.push("");
  }

  // Synergies
  if (synergies.length > 0) {
    lines.push(`## シナジー（組み合わせ技）`);
    for (const s of synergies) {
      lines.push(`- **${s.synergy_type}**: ${s.effect ?? ""}`);
      if (s.annual_impact) lines.push(`  年間効果: ${s.annual_impact}`);
    }
    lines.push("");
  }

  // Point exchanges
  if (exchanges.length > 0) {
    lines.push(`## ポイント交換先`);
    lines.push(`| 交換先 | レート | 評価 |`);
    lines.push(`|--------|--------|------|`);
    for (const e of exchanges) {
      lines.push(`| ${e.to_point} | ${e.rate ?? "—"} | ${e.efficiency ?? ""} |`);
    }
    lines.push("");
  }

  // App CTA
  lines.push(`---`);
  lines.push(`🔗 プロモ情報・申込み・類似カード比較は Card Wize アプリで`);
  lines.push(`→ ${APP_BASE_URL}/card/${c.card_id}`);
  lines.push("");
  lines.push(
    `💡 マイカード登録すれば、あなたの手持ちカードで最適な支払い方法を自動判定します`
  );

  return lines.join("\n");
}
