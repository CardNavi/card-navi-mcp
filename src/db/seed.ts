#!/usr/bin/env node

/**
 * Seed the CardNavi MCP database from 189 individual card JSON files.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getDb, closeDb } from "./connection.js";
import { initSchema } from "./schema.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Card data directory
const CARD_DIR =
  process.env.CARD_DATA_DIR ??
  join(__dirname, "..", "..", "..", "01_カードデータ");

interface CardJson {
  card_id: string;
  card_name: string;
  collected_at?: string;
  basic_specs?: {
    issuer?: string;
    brand?: string | string[];
    annual_fee?: number;
    annual_fee_waiver?: string;
    base_reward_rate?: number;
    point_program?: string;
    electronic_money?: string | string[];
    apple_pay?: boolean;
    google_pay?: boolean;
    touch_payment?: string;
    min_age?: number;
    url_official?: string;
  };
  reward_rates?: Array<{
    store_name: string;
    category?: string;
    reward_rate: number;
    condition?: string;
    period?: string;
  }>;
  insurance?: Array<{
    insurance_type: string;
    coverage?: string;
    max_amount?: string;
    condition?: string;
    notes?: string;
  }>;
  synergies?: Array<{
    synergy_type: string;
    condition_a?: string;
    condition_b?: string;
    effect?: string;
    annual_impact?: string;
    awareness?: string;
  }>;
  point_exchange_routes?: Array<{
    to_point: string;
    rate?: string;
    min_unit?: string;
    days?: string;
    efficiency?: string;
  }>;
}

function main(): void {
  const db = getDb();
  initSchema(db);

  console.log(`Loading cards from ${CARD_DIR}...`);

  const files = readdirSync(CARD_DIR).filter((f) => f.endsWith(".json"));
  console.log(`Found ${files.length} card files`);

  const upsertCard = db.prepare(`
    INSERT INTO cards (
      card_id, card_name, issuer, brand, annual_fee, annual_fee_text,
      base_reward_rate, point_program, electronic_money,
      apple_pay, google_pay, touch_payment, min_age, url_official, collected_at
    ) VALUES (
      @card_id, @card_name, @issuer, @brand, @annual_fee, @annual_fee_text,
      @base_reward_rate, @point_program, @electronic_money,
      @apple_pay, @google_pay, @touch_payment, @min_age, @url_official, @collected_at
    )
    ON CONFLICT(card_id) DO UPDATE SET
      card_name = excluded.card_name,
      issuer = excluded.issuer,
      brand = excluded.brand,
      annual_fee = excluded.annual_fee,
      annual_fee_text = excluded.annual_fee_text,
      base_reward_rate = excluded.base_reward_rate,
      point_program = excluded.point_program,
      electronic_money = excluded.electronic_money,
      apple_pay = excluded.apple_pay,
      google_pay = excluded.google_pay,
      touch_payment = excluded.touch_payment,
      min_age = excluded.min_age,
      url_official = excluded.url_official,
      collected_at = excluded.collected_at
  `);

  const insertReward = db.prepare(`
    INSERT INTO reward_rates (card_id, store_name, category, reward_rate, condition, period)
    VALUES (@card_id, @store_name, @category, @reward_rate, @condition, @period)
    ON CONFLICT(card_id, store_name, condition) DO UPDATE SET
      category = excluded.category,
      reward_rate = excluded.reward_rate,
      period = excluded.period
  `);

  const insertInsurance = db.prepare(`
    INSERT INTO insurance (card_id, insurance_type, coverage, max_amount, condition, notes)
    VALUES (@card_id, @insurance_type, @coverage, @max_amount, @condition, @notes)
  `);

  const insertSynergy = db.prepare(`
    INSERT INTO synergies (card_id, synergy_type, condition_a, condition_b, effect, annual_impact, awareness)
    VALUES (@card_id, @synergy_type, @condition_a, @condition_b, @effect, @annual_impact, @awareness)
  `);

  const insertExchange = db.prepare(`
    INSERT INTO point_exchanges (card_id, to_point, rate, min_unit, days, efficiency)
    VALUES (@card_id, @to_point, @rate, @min_unit, @days, @efficiency)
  `);

  // Clear related tables before re-seeding (cards table uses UPSERT)
  db.exec(`DELETE FROM reward_rates`);
  db.exec(`DELETE FROM insurance`);
  db.exec(`DELETE FROM synergies`);
  db.exec(`DELETE FROM point_exchanges`);

  let cardCount = 0;
  let rewardCount = 0;
  let insuranceCount = 0;
  let synergyCount = 0;
  let exchangeCount = 0;

  const seedOneCard = db.transaction((file: string) => {
    const raw = readFileSync(join(CARD_DIR, file), "utf-8");
    const card: CardJson = JSON.parse(raw);
    const specs = card.basic_specs ?? {};

    const brandStr = Array.isArray(specs.brand)
      ? specs.brand.join(",")
      : specs.brand ?? null;
    const emoneyStr = Array.isArray(specs.electronic_money)
      ? specs.electronic_money.join(",")
      : specs.electronic_money ?? null;

    upsertCard.run({
      card_id: card.card_id,
      card_name: card.card_name,
      issuer: specs.issuer ?? null,
      brand: brandStr,
      annual_fee: specs.annual_fee ?? null,
      annual_fee_text: specs.annual_fee_waiver ?? null,
      base_reward_rate: specs.base_reward_rate ?? null,
      point_program: specs.point_program ?? null,
      electronic_money: emoneyStr,
      apple_pay: specs.apple_pay ? 1 : 0,
      google_pay: specs.google_pay ? 1 : 0,
      touch_payment: specs.touch_payment ?? null,
      min_age: specs.min_age ?? null,
      url_official: specs.url_official ?? null,
      collected_at: card.collected_at ?? null,
    });
    cardCount++;

    // Reward rates
    if (card.reward_rates) {
      for (const r of card.reward_rates) {
        if (!r.store_name) continue;
        try {
          insertReward.run({
            card_id: card.card_id,
            store_name: r.store_name,
            category: r.category ?? null,
            reward_rate: r.reward_rate ?? 0,
            condition: r.condition ?? null,
            period: r.period ?? null,
          });
          rewardCount++;
        } catch {
          // skip duplicates
        }
      }
    }

    // Insurance
    if (Array.isArray(card.insurance)) {
      for (const ins of card.insurance) {
        if (!ins || !ins.insurance_type) continue;
        insertInsurance.run({
          card_id: card.card_id,
          insurance_type: ins.insurance_type,
          coverage: ins.coverage ?? null,
          max_amount: ins.max_amount ?? null,
          condition: ins.condition ?? null,
          notes: ins.notes ?? null,
        });
        insuranceCount++;
      }
    }

    // Synergies
    if (Array.isArray(card.synergies)) {
      for (const syn of card.synergies) {
        if (!syn || !syn.synergy_type) continue;
        insertSynergy.run({
          card_id: card.card_id,
          synergy_type: syn.synergy_type,
          condition_a: syn.condition_a ?? null,
          condition_b: syn.condition_b ?? null,
          effect: syn.effect ?? null,
          annual_impact: syn.annual_impact ?? null,
          awareness: syn.awareness ?? null,
        });
        synergyCount++;
      }
    }

    // Point exchanges
    if (Array.isArray(card.point_exchange_routes)) {
      for (const ex of card.point_exchange_routes) {
        if (!ex || !ex.to_point) continue;
        insertExchange.run({
          card_id: card.card_id,
          to_point: ex.to_point,
          rate: ex.rate ?? null,
          min_unit: ex.min_unit ?? null,
          days: ex.days ?? null,
          efficiency: ex.efficiency ?? null,
        });
        exchangeCount++;
      }
    }
  });

  for (const file of files) {
    try {
      seedOneCard(file);
    } catch (err) {
      console.error(`Error processing ${file}:`, (err as Error).message);
    }
  }

  // Rebuild FTS index
  db.exec(`DELETE FROM cards_fts`);
  db.exec(`
    INSERT INTO cards_fts(card_id, card_name, issuer, brand, point_program, electronic_money)
    SELECT card_id, card_name, issuer, brand, point_program, electronic_money FROM cards
  `);

  console.log("\n=== Seed Summary ===");
  console.log(`Cards:           ${cardCount}`);
  console.log(`Reward rates:    ${rewardCount}`);
  console.log(`Insurance:       ${insuranceCount}`);
  console.log(`Synergies:       ${synergyCount}`);
  console.log(`Point exchanges: ${exchangeCount}`);
  console.log("Seed complete!");

  closeDb();
}

main();
