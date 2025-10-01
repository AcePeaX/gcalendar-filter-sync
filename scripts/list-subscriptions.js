
import "dotenv/config";
import Database from "better-sqlite3";
const db = new Database(process.env.DB_PATH || "./sync.db");
const rows = db
    .prepare(
        `SELECT id, token_key, source_calendar_id, target_calendar_id, filter_type, filters_raw, is_enabled FROM subscriptions`
    )
    .all();
for (const r of rows) {
    console.log(
        `${r.id} | ${r.is_enabled ? "ENABLED" : "disabled"} | ${
            r.token_key
        } | ${r.source_calendar_id} -> ${r.target_calendar_id} | ${
            r.filter_type
        } | ${r.filters_raw}`
    );
}
