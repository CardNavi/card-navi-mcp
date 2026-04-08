import type Database from "better-sqlite3";

export function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cards (
      card_id         TEXT PRIMARY KEY,
      card_name       TEXT NOT NULL,
      issuer          TEXT,
      brand           TEXT,
      annual_fee      INTEGER,
      annual_fee_text TEXT,
      base_reward_rate REAL,
      point_program   TEXT,
      electronic_money TEXT,
      apple_pay       INTEGER DEFAULT 0,
      google_pay      INTEGER DEFAULT 0,
      touch_payment   TEXT,
      min_age         INTEGER,
      url_official    TEXT,
      collected_at    TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_cards_issuer ON cards(issuer);
    CREATE INDEX IF NOT EXISTS idx_cards_annual_fee ON cards(annual_fee);
    CREATE INDEX IF NOT EXISTS idx_cards_base_rate ON cards(base_reward_rate);

    CREATE TABLE IF NOT EXISTS reward_rates (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id     TEXT NOT NULL REFERENCES cards(card_id),
      store_name  TEXT NOT NULL,
      category    TEXT,
      reward_rate REAL NOT NULL,
      condition   TEXT,
      period      TEXT,
      UNIQUE(card_id, store_name, condition)
    );

    CREATE INDEX IF NOT EXISTS idx_reward_card ON reward_rates(card_id);
    CREATE INDEX IF NOT EXISTS idx_reward_store ON reward_rates(store_name);
    CREATE INDEX IF NOT EXISTS idx_reward_category ON reward_rates(category);
    CREATE INDEX IF NOT EXISTS idx_reward_rate ON reward_rates(reward_rate);

    CREATE TABLE IF NOT EXISTS insurance (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id         TEXT NOT NULL REFERENCES cards(card_id),
      insurance_type  TEXT NOT NULL,
      coverage        TEXT,
      max_amount      TEXT,
      condition       TEXT,
      notes           TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_insurance_card ON insurance(card_id);

    CREATE TABLE IF NOT EXISTS synergies (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id       TEXT NOT NULL REFERENCES cards(card_id),
      synergy_type  TEXT NOT NULL,
      condition_a   TEXT,
      condition_b   TEXT,
      effect        TEXT,
      annual_impact TEXT,
      awareness     TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_synergies_card ON synergies(card_id);

    CREATE TABLE IF NOT EXISTS point_exchanges (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id   TEXT NOT NULL REFERENCES cards(card_id),
      to_point  TEXT NOT NULL,
      rate      TEXT,
      min_unit  TEXT,
      days      TEXT,
      efficiency TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_exchange_card ON point_exchanges(card_id);

    -- FTS for searching cards (standalone, not content-synced — rebuilt by seed)
    CREATE VIRTUAL TABLE IF NOT EXISTS cards_fts USING fts5(
      card_id,
      card_name,
      issuer,
      brand,
      point_program,
      electronic_money,
      tokenize='unicode61'
    );
  `);
}
