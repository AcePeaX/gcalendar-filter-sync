// migrate.js
import "dotenv/config";
import Database from "better-sqlite3";

const DB_PATH = process.env.DB_PATH || "./sync.db";
const db = new Database(DB_PATH);

// ---------- PRAGMAs (durability + perf) ----------
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("synchronous = NORMAL");

// ---------- helpers ----------
function getUserVersion() {
    // better-sqlite3 returns a number with simple: true
    return db.pragma("user_version", { simple: true });
}

function setUserVersion(v) {
    db.pragma(`user_version = ${Number(v) | 0}`);
}

function hasTable(name) {
    const row = db
        .prepare(
            `SELECT 1 FROM sqlite_master WHERE type='table' AND name = ? LIMIT 1`
        )
        .get(name);
    return !!row;
}

function hasColumn(table, column) {
    const cols = db.pragma(`table_info(${table})`);
    return cols.some((c) => c.name === column);
}

// Just ensure (create if missing) a named index exactly as provided.
function ensureIndex(sqlCreateIndex) {
    // Rely on "CREATE ... IF NOT EXISTS" inside the statement
    db.exec(sqlCreateIndex);
}

// ---------- migrations ----------
/**
 * v1 — initial schema (idempotent via IF NOT EXISTS)
 * Tables:
 *  - subscriptions
 *  - subscription_state
 *  - event_mappings
 * Index:
 *  - ux_sub_unique (partial unique on enabled subs)
 */
function migrateToV1() {
    db.exec(`
  CREATE TABLE IF NOT EXISTS subscriptions (
    id                 TEXT PRIMARY KEY,
    token_key          TEXT NOT NULL,                         -- e.g. "acepeax"
    source_calendar_id TEXT NOT NULL,
    target_calendar_id TEXT NOT NULL,
    filter_type        TEXT NOT NULL DEFAULT 'keywords',      -- 'keywords' | 'regex'
    filters_raw        TEXT NOT NULL,                         -- "Math 201,AI 305" or regex
    is_enabled         INTEGER NOT NULL DEFAULT 1,
    created_at         INTEGER NOT NULL,
    updated_at         INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS subscription_state (
    subscription_id TEXT PRIMARY KEY
      REFERENCES subscriptions(id) ON DELETE CASCADE,
    sync_token      TEXT,
    last_run_at     INTEGER,
    last_status     TEXT
  );
  CREATE TABLE IF NOT EXISTS event_mappings (
    subscription_id TEXT NOT NULL
      REFERENCES subscriptions(id) ON DELETE CASCADE,
    source_id       TEXT NOT NULL,
    target_id       TEXT NOT NULL,
    etag            TEXT NOT NULL,
    PRIMARY KEY (subscription_id, source_id)
  );
  `);

    // Partial unique index (only for enabled subs)
    ensureIndex(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_sub_unique
    ON subscriptions (token_key, source_calendar_id, target_calendar_id)
    WHERE is_enabled = 1;
  `);
}

/**
 * v2 — add event_mappings.fingerprint (if missing)
 */
function migrateToV2() {
    if (!hasColumn("event_mappings", "fingerprint")) {
        db.exec(`ALTER TABLE event_mappings ADD COLUMN fingerprint TEXT;`);

        const info = db.prepare(`DELETE FROM event_mappings;`).run();
        console.log(`🧹 Cleared ${info.changes} rows from event_mappings during v2 migration`);
    }
}

// Add future migrations here (v3, v4, ...) and bump LATEST_VERSION.
const migrations = [
    { version: 1, up: migrateToV1 },
    { version: 2, up: migrateToV2 },
];

const LATEST_VERSION = migrations[migrations.length - 1].version;

// ---------- runner ----------
function runMigrations() {
    const before = getUserVersion();
    if (before >= LATEST_VERSION) {
        console.log(`✅ DB up-to-date (user_version=${before})`);
        return;
    }

    db.transaction(() => {
        for (const m of migrations) {
            if (m.version > before) {
                m.up();
                setUserVersion(m.version);
                console.log(`📦 Applied migration v${m.version}`);
            }
        }
    })();

    const after = getUserVersion();
    console.log(`✅ DB migrated to v${after}`);
}

// ---------- execute ----------
runMigrations();
