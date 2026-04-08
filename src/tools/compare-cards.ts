import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";

const APP_BASE_URL = "https://card-navi.app";

const CompareInput = z.object({
  card_ids: z
    .array(z.string())
    .min(2)
    .max(5)
    .describe(
      "Card IDs to compare (2-5 cards), e.g. ['rakuten_standard', 'smbc_nl', 'jcb_card_w']"
    ),
  focus: z
    .string()
    .optional()
    .describe(
      "Comparison focus: 'rewards' (還元率), 'insurance' (保険), 'fees' (年会費), 'all' (default)"
    ),
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
  apple_pay: number;
  google_pay: number;
}

interface RewardRow {
  store_name: string;
  category: string | null;
  reward_rate: number;
}

interface InsuranceRow {
  insurance_type: string;
  max_amount: string | null;
  condition: string | null;
}

export function register(server: McpServer, db: Database.Database): void {
  server.tool(
    "compare_cards",
    "Side-by-side comparison of 2-5 credit cards — annual fee, reward rates, insurance, payment methods. Can focus on specific aspects. For interactive comparison tool and card swap simulator → Card Navi app.",
    CompareInput.shape,
    async ({ card_ids, focus }) => {
      const cards: CardRow[] = [];
      for (const id of card_ids) {
        let card = db
          .prepare("SELECT * FROM cards WHERE card_id = ?")
          .get(id) as CardRow | undefined;
        if (!card) {
          card = db
            .prepare("SELECT * FROM cards WHERE card_name LIKE ? LIMIT 1")
            .get(`%${id}%`) as CardRow | undefined;
        }
        if (card) cards.push(card);
      }

      if (cards.length < 2) {
        return {
          content: [
            {
              type: "text" as const,
              text: `比較するには2枚以上のカードが必要です。見つかったカード: ${cards.length}枚\n指定されたID: ${card_ids.join(", ")}`,
            },
          ],
        };
      }

      const focusMode = focus ?? "all";
      const lines: string[] = [
        `# 💳 カード比較（${cards.length}枚）\n`,
      ];

      // Basic specs comparison table
      lines.push(`## 基本スペック`);
      lines.push(
        `| 項目 | ${cards.map((c) => `**${c.card_name}**`).join(" | ")} |`
      );
      lines.push(`|------|${cards.map(() => "------").join("|")}|`);
      lines.push(
        `| 年会費 | ${cards.map((c) => feeStr(c)).join(" | ")} |`
      );
      lines.push(
        `| 基本還元率 | ${cards.map((c) => (c.base_reward_rate ? `${c.base_reward_rate}%` : "—")).join(" | ")} |`
      );
      lines.push(
        `| ブランド | ${cards.map((c) => c.brand ?? "—").join(" | ")} |`
      );
      lines.push(
        `| ポイント | ${cards.map((c) => c.point_program ?? "—").join(" | ")} |`
      );
      lines.push(
        `| Apple Pay | ${cards.map((c) => (c.apple_pay ? "✅" : "❌")).join(" | ")} |`
      );
      lines.push(
        `| Google Pay | ${cards.map((c) => (c.google_pay ? "✅" : "❌")).join(" | ")} |`
      );
      lines.push("");

      // Reward rate comparison
      if (focusMode === "all" || focusMode === "rewards") {
        lines.push(`## 還元率比較`);

        // Collect all store categories across cards
        const allRewards = new Map<string, Map<string, number>>();
        for (const card of cards) {
          const rewards = db
            .prepare(
              "SELECT store_name, category, reward_rate FROM reward_rates WHERE card_id = ? ORDER BY reward_rate DESC LIMIT 8"
            )
            .all(card.card_id) as RewardRow[];

          for (const r of rewards) {
            if (!allRewards.has(r.store_name)) {
              allRewards.set(r.store_name, new Map());
            }
            allRewards.get(r.store_name)!.set(card.card_id, r.reward_rate);
          }
        }

        // Sort stores by max reward rate
        const sortedStores = [...allRewards.entries()]
          .sort((a, b) => {
            const maxA = Math.max(...a[1].values());
            const maxB = Math.max(...b[1].values());
            return maxB - maxA;
          })
          .slice(0, 10);

        if (sortedStores.length > 0) {
          lines.push(
            `| 店舗 | ${cards.map((c) => `**${shortName(c.card_name)}**`).join(" | ")} |`
          );
          lines.push(`|------|${cards.map(() => "------").join("|")}|`);

          for (const [store, rates] of sortedStores) {
            const cols = cards.map((c) => {
              const rate = rates.get(c.card_id);
              if (!rate) return "—";
              // Highlight the winner
              const isMax =
                rate === Math.max(...cards.map((cc) => rates.get(cc.card_id) ?? 0));
              return isMax ? `**${rate}%** 🏆` : `${rate}%`;
            });
            lines.push(`| ${store} | ${cols.join(" | ")} |`);
          }
          lines.push("");
        }
      }

      // Insurance comparison
      if (focusMode === "all" || focusMode === "insurance") {
        lines.push(`## 付帯保険`);
        for (const card of cards) {
          const ins = db
            .prepare(
              "SELECT insurance_type, max_amount, condition FROM insurance WHERE card_id = ?"
            )
            .all(card.card_id) as InsuranceRow[];

          if (ins.length > 0) {
            lines.push(`**${card.card_name}**:`);
            for (const i of ins) {
              lines.push(
                `- ${i.insurance_type}: ${i.max_amount ?? "—"} (${i.condition ?? "—"})`
              );
            }
          } else {
            lines.push(`**${card.card_name}**: 付帯保険なし`);
          }
        }
        lines.push("");
      }

      // Verdict
      lines.push(`## まとめ`);
      const cheapest = [...cards].sort(
        (a, b) => (a.annual_fee ?? 0) - (b.annual_fee ?? 0)
      )[0];
      const highestRate = [...cards].sort(
        (a, b) =>
          (b.base_reward_rate ?? 0) - (a.base_reward_rate ?? 0)
      )[0];

      lines.push(`- 💰 年会費最安: **${cheapest.card_name}** (${feeStr(cheapest)})`);
      lines.push(
        `- 🏆 基本還元率トップ: **${highestRate.card_name}** (${highestRate.base_reward_rate}%)`
      );
      lines.push("");

      lines.push(`---`);
      lines.push(
        `🔗 インタラクティブ比較ツール・カード乗り換えシミュレーターは Card Navi アプリで`
      );
      lines.push(`→ ${APP_BASE_URL}/compare`);

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    }
  );
}

function feeStr(c: CardRow): string {
  if (c.annual_fee === 0) return "無料";
  if (c.annual_fee !== null) return `${c.annual_fee.toLocaleString()}円`;
  return "—";
}

function shortName(name: string): string {
  // Truncate long card names for table headers
  return name.length > 12 ? name.slice(0, 11) + "…" : name;
}
