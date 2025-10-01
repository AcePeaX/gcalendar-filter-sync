import "dotenv/config";
import Database from "better-sqlite3";

const db = new Database(process.env.DB_PATH || "./sync.db");
db.exec(`
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS subscriptions (
  id                 TEXT PRIMARY KEY,
  token_key          TEXT NOT NULL,               -- key used in tokenStore (e.g. "acepeax")
  source_calendar_id TEXT NOT NULL,
  target_calendar_id TEXT NOT NULL,
  filter_type        TEXT NOT NULL DEFAULT 'keywords',  -- 'keywords' | 'regex'
  filters_raw        TEXT NOT NULL,               -- e.g. "Math 201,AI 305" or regex
  is_enabled         INTEGER NOT NULL DEFAULT 1,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS subscription_state (
  subscription_id TEXT PRIMARY KEY REFERENCES subscriptions(id) ON DELETE CASCADE,
  sync_token      TEXT,
  last_run_at     INTEGER,
  last_status     TEXT
);
CREATE TABLE IF NOT EXISTS event_mappings (
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  source_id       TEXT NOT NULL,
  target_id       TEXT NOT NULL,
  etag            TEXT NOT NULL,
  PRIMARY KEY (subscription_id, source_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_sub_unique
ON subscriptions (token_key, source_calendar_id, target_calendar_id)
WHERE is_enabled = 1;
`);
console.log("✅ DB migrated");
