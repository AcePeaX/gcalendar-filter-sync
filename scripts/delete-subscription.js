// scripts/delete-subscription.js
import "dotenv/config";
import Database from "better-sqlite3";
import readline from "readline/promises";
import { stdin as input, stdout as output } from "node:process";

const db = new Database(process.env.DB_PATH || "./sync.db");

function listSubs() {
    return db
        .prepare(
            `SELECT id, is_enabled, token_key, source_calendar_id, target_calendar_id, filter_type, filters_raw
       FROM subscriptions
       ORDER BY updated_at DESC`
        )
        .all();
}

function deleteSub(subId) {
    // remove mappings and state first (robust even if FKs exist)
    db.prepare(`DELETE FROM event_mappings WHERE subscription_id=?`).run(subId);
    db.prepare(`DELETE FROM subscription_state WHERE subscription_id=?`).run(
        subId
    );
    const info = db.prepare(`DELETE FROM subscriptions WHERE id=?`).run(subId);
    return info.changes > 0;
}

async function main() {
    const subIdFromArg = process.argv[2];

    if (subIdFromArg) {
        const ok = deleteSub(subIdFromArg);
        if (!ok) {
            console.error("No subscription found with id:", subIdFromArg);
            process.exit(1);
        }
        console.log("✅ Deleted subscription:", subIdFromArg);
        return;
    }

    // Interactive mode
    const subs = listSubs();
    if (subs.length === 0) {
        console.log("No subscriptions found.");
        return;
    }

    console.log("Available subscriptions:");
    subs.forEach((s, i) => {
        console.log(
            `${i + 1}. ${s.id} | ${s.is_enabled ? "ENABLED" : "disabled"} | ${
                s.token_key
            } | ${s.source_calendar_id} -> ${s.target_calendar_id} | ${
                s.filter_type
            } | ${s.filters_raw}`
        );
    });

    const rl = readline.createInterface({ input, output });
    try {
        const idxStr = await rl.question("\nEnter the number to delete: ");
        const idx = Number(idxStr);
        if (!idx || idx < 1 || idx > subs.length) {
            console.error("Invalid selection.");
            process.exit(1);
        }
        const chosen = subs[idx - 1];

        const confirm = await rl.question(
            `Type "DELETE" to confirm deleting ${chosen.id}: `
        );
        if (confirm !== "DELETE") {
            console.log("Cancelled.");
            return;
        }

        const ok = deleteSub(chosen.id);
        if (ok) {
            console.log("✅ Deleted subscription:", chosen.id);
        } else {
            console.error("Delete failed (not found?).");
            process.exit(1);
        }
    } finally {
        rl.close();
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
