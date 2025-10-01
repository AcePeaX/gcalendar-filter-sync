// scripts/force-resync.js
import "dotenv/config";
import Database from "better-sqlite3";
import readline from "readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { google } from "googleapis";
import { createTokenStore } from "./tokenStore.js";

const db = new Database(process.env.DB_PATH || "./sync.db");
const store = createTokenStore(process.env.TOKENSTORE_DIR || "./secure_tokens");

function listSubs() {
    return db
        .prepare(
            `
    SELECT id, token_key, source_calendar_id, target_calendar_id, is_enabled, filter_type, filters_raw
    FROM subscriptions ORDER BY updated_at DESC
  `
        )
        .all();
}

function softReset(subId) {
    db.prepare(`DELETE FROM event_mappings WHERE subscription_id=?`).run(subId);
    db.prepare(
        `
    INSERT INTO subscription_state(subscription_id,sync_token,last_run_at,last_status)
    VALUES(?,?,?,?)
    ON CONFLICT(subscription_id) DO UPDATE SET
      sync_token=NULL, last_run_at=NULL, last_status=NULL
  `
    ).run(subId, null, null, null);
}

async function oauthForTokenKey(tokenKey) {
    const payload = await store.load(tokenKey);
    if (!payload?.tokens?.refresh_token)
        throw new Error(`No refresh token for tokenKey=${tokenKey}`);
    const oauth2 = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_REDIRECT_URI
    );
    oauth2.setCredentials({ refresh_token: payload.tokens.refresh_token });
    return oauth2;
}

// Only used in --hard mode
async function hardDeleteAllMirrored(sub) {
    const oauth2 = await oauthForTokenKey(sub.token_key);
    const calendar = google.calendar({ version: "v3", auth: oauth2 });
    const maps = db
        .prepare(`SELECT target_id FROM event_mappings WHERE subscription_id=?`)
        .all(sub.id);
    let deleted = 0;
    for (const m of maps) {
        try {
            await calendar.events.delete({
                calendarId: sub.target_calendar_id,
                eventId: m.target_id,
            });
            deleted++;
        } catch (e) {
            // tolerate already-gone
            if (e?.code !== 404 && e?.code !== 410) throw e;
        }
    }
    return deleted;
}

async function pickSubInteractive() {
    const subs = listSubs();
    if (subs.length === 0) {
        console.log("No subscriptions found.");
        process.exit(0);
    }
    console.log("Subscriptions:");
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
        const idxStr = await rl.question(
            "\nPick a subscription number to force resync: "
        );
        const idx = Number(idxStr);
        if (!idx || idx < 1 || idx > subs.length) {
            console.error("Invalid selection.");
            process.exit(1);
        }
        return subs[idx - 1];
    } finally {
        rl.close();
    }
}

async function main() {
    const args = new Set(
        process.argv.slice(2).filter((a) => a.startsWith("--"))
    );
    const positionals = process.argv
        .slice(2)
        .filter((a) => !a.startsWith("--"));
    const hard = args.has("--hard");
    const all = args.has("--all");
    let targets = [];

    if (all) {
        targets = listSubs();
    } else if (positionals[0]) {
        const sub = db
            .prepare(`SELECT * FROM subscriptions WHERE id=?`)
            .get(positionals[0]);
        if (!sub) {
            console.error("Subscription not found:", positionals[0]);
            process.exit(1);
        }
        targets = [sub];
    } else {
        const sub = await pickSubInteractive();
        targets = [sub];
    }

    for (const sub of targets) {
        if (hard) {
            process.stdout.write(
                `Force-resync (HARD) ${sub.id} — deleting mirrored events... `
            );
            const deleted = await hardDeleteAllMirrored(sub);
            console.log(`deleted ${deleted}.`);
        }
        // Soft reset always happens (even after hard delete)
        softReset(sub.id);
        console.log(
            `Soft reset done for ${sub.id} (cleared mappings + sync token).`
        );
    }

    console.log("\n✅ Force resync prepared. Now run the worker to rebuild:");
    console.log("   npm run worker\n");
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
