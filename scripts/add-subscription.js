// script/add-subscription.js
import "dotenv/config";
import Database from "better-sqlite3";
import { randomUUID } from "crypto";

const db = new Database(process.env.DB_PATH || "./sync.db");

const [, , tokenKey, sourceCalId, targetCalId, ...filters] = process.argv;

if (!tokenKey || !sourceCalId || !targetCalId || filters.length === 0) {
    console.error(
        "Usage:\n  node script/add-subscription.js <TOKEN_KEY> <SOURCE_CAL_ID> <TARGET_CAL_ID> <filters...>"
    );
    console.error("\nExamples:");
    console.error(
        "  node script/add-subscription.js acepeax all_courses@group.calendar.google.com you@gmail.com Math 201 AI 305 PHY101"
    );
    process.exit(1);
}

const id = randomUUID();
const filterStr = filters.join(","); // comma-separated keywords

db.prepare(
    `
  INSERT INTO subscriptions(id,token_key,source_calendar_id,target_calendar_id,filter_type,filters_raw,is_enabled,created_at,updated_at)
  VALUES(?,?,?,?,?,?,1,?,?)
`
).run(
    id,
    tokenKey,
    sourceCalId,
    targetCalId,
    "keywords",
    filterStr,
    Date.now(),
    Date.now()
);

db.prepare(
    `
  INSERT INTO subscription_state(subscription_id,sync_token,last_run_at,last_status)
  VALUES(?,?,?,?)
  ON CONFLICT(subscription_id) DO UPDATE SET sync_token=excluded.sync_token
`
).run(id, null, null, null);

console.log("✅ Subscription added:", id);
