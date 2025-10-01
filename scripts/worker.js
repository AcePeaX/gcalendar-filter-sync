import "dotenv/config";
import pino from "pino";
import Database from "better-sqlite3";
import { google } from "googleapis";
import { createTokenStore } from "./tokenStore.js";

const log = pino({ level: process.env.LOG_LEVEL || "info" });

const DB_PATH = process.env.DB_PATH || "./sync.db";
const db = new Database(DB_PATH);
const store = createTokenStore(process.env.TOKENSTORE_DIR || "./secure_tokens");

// ---------- helpers ----------
function oauthForTokenKey(tokenKey) {
    const rec = db.prepare("SELECT 1").get(); // just to ensure DB open (optional)
    return (async () => {
        const payload = await store.load(tokenKey);
        if (!payload?.tokens?.refresh_token) {
            throw new Error(`No refresh token for tokenKey=${tokenKey}`);
        }
        const oauth2 = new google.auth.OAuth2(
            process.env.GOOGLE_CLIENT_ID,
            process.env.GOOGLE_CLIENT_SECRET,
            process.env.GOOGLE_REDIRECT_URI
        );
        oauth2.setCredentials({ refresh_token: payload.tokens.refresh_token });
        return oauth2;
    })();
}

function makeMatcher(filter_type, filters_raw) {
    if (filter_type === "regex") {
        const re = new RegExp(filters_raw, "i");
        return (title = "") => re.test(title);
    }
    const keys = filters_raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    return (title = "") => {
        const t = (title || "").toLowerCase();
        return keys.some((k) => t.includes(k.toLowerCase()));
    };
}

async function listChanges(calendar, calId, params) {
    const res = await calendar.events.list({
        calendarId: calId,
        showDeleted: true,
        singleEvents: false, // use master + exceptions; incremental feed handles deltas
        maxResults: 2500,
        ...params,
    });
    return res.data;
}

async function upsertTarget(calendar, subId, targetCalId, ev) {
    const existing = db
        .prepare(
            `
    SELECT * FROM event_mappings WHERE subscription_id=? AND source_id=?
  `
        )
        .get(subId, ev.id);

    const payload = {
        summary: ev.summary,
        description: ev.description,
        location: ev.location,
        start: ev.start,
        end: ev.end,
        recurrence: ev.recurrence,
        reminders: ev.reminders?.useDefault
            ? { useDefault: true }
            : ev.reminders,
        transparency: ev.transparency || "opaque",
        // You can add colorId or other props if you like
    };

    if (existing) {
        if (existing.etag !== ev.etag) {
            const updated = await calendar.events.update({
                calendarId: targetCalId,
                eventId: existing.target_id,
                requestBody: payload,
            });
            db.prepare(
                `
        INSERT INTO event_mappings(subscription_id,source_id,target_id,etag)
        VALUES(?,?,?,?)
        ON CONFLICT(subscription_id,source_id) DO UPDATE SET target_id=excluded.target_id, etag=excluded.etag
      `
            ).run(subId, ev.id, updated.data.id, ev.etag);
            log.debug({ subId, ev: ev.id }, "updated");
        }
    } else {
        const created = await calendar.events.insert({
            calendarId: targetCalId,
            requestBody: payload,
        });
        db.prepare(
            `
      INSERT INTO event_mappings(subscription_id,source_id,target_id,etag)
      VALUES(?,?,?,?)
    `
        ).run(subId, ev.id, created.data.id, ev.etag);
        log.debug({ subId, ev: ev.id }, "created");
    }
}

async function removeTarget(calendar, subId, targetCalId, sourceId) {
    const row = db
        .prepare(
            `
    SELECT * FROM event_mappings WHERE subscription_id=? AND source_id=?
  `
        )
        .get(subId, sourceId);
    if (!row) return;
    try {
        await calendar.events.delete({
            calendarId: targetCalId,
            eventId: row.target_id,
        });
    } catch (e) {
        if (e?.code !== 404) throw e;
    }
    db.prepare(
        "DELETE FROM event_mappings WHERE subscription_id=? AND source_id=?"
    ).run(subId, sourceId);
    log.debug({ subId, ev: sourceId }, "deleted");
}

async function runSubscription(sub) {
    const oauth2 = await oauthForTokenKey(sub.token_key);
    const calendar = google.calendar({ version: "v3", auth: oauth2 });
    const match = makeMatcher(sub.filter_type, sub.filters_raw);

    const state = db
        .prepare("SELECT * FROM subscription_state WHERE subscription_id=?")
        .get(sub.id);
    let pageToken = undefined;

    const saveState = (patch) => {
        db.prepare(
            `
      INSERT INTO subscription_state(subscription_id,sync_token,last_run_at,last_status)
      VALUES(?,?,?,?)
      ON CONFLICT(subscription_id) DO UPDATE SET
        sync_token=COALESCE(excluded.sync_token, subscription_state.sync_token),
        last_run_at=COALESCE(excluded.last_run_at, subscription_state.last_run_at),
        last_status=COALESCE(excluded.last_status, subscription_state.last_status)
    `
        ).run(
            sub.id,
            patch.sync_token ?? null,
            patch.last_run_at ?? Date.now(),
            patch.last_status ?? "ok"
        );
    };

    try {
        do {
            const data = await listChanges(calendar, sub.source_calendar_id, {
                pageToken,
                ...(state?.sync_token ? { syncToken: state.sync_token } : {}),
            });

            for (const ev of data.items || []) {
                if (ev.status === "cancelled") {
                    await removeTarget(
                        calendar,
                        sub.id,
                        sub.target_calendar_id,
                        ev.id
                    );
                    continue;
                }
                if (match(ev.summary || "")) {
                    await upsertTarget(
                        calendar,
                        sub.id,
                        sub.target_calendar_id,
                        ev
                    );
                } else {
                    // No longer matches → ensure removal
                    await removeTarget(
                        calendar,
                        sub.id,
                        sub.target_calendar_id,
                        ev.id
                    );
                }
            }

            pageToken = data.nextPageToken || undefined;
            if (data.nextSyncToken) {
                saveState({
                    sync_token: data.nextSyncToken,
                    last_status: "ok",
                });
                break;
            }
        } while (pageToken);
    } catch (e) {
        if (e?.code === 410) {
            // syncToken invalid/expired — reset and redo a fresh pass
            db.prepare(
                "UPDATE subscription_state SET sync_token=NULL WHERE subscription_id=?"
            ).run(sub.id);
            log.warn(
                { subId: sub.id },
                "sync token expired — fresh sync next run"
            );
            return;
        }
        log.error(
            { subId: sub.id, err: e?.message },
            "subscription sync failed"
        );
        // keep last_status=error
        saveState({ last_status: "error" });
        throw e;
    }
    saveState({ last_status: "ok" });
}

async function runAll() {
    const subs = db
        .prepare(
            `
    SELECT * FROM subscriptions WHERE is_enabled=1
  `
        )
        .all();
    for (const sub of subs) {
        log.info(
            {
                subId: sub.id,
                src: sub.source_calendar_id,
                dst: sub.target_calendar_id,
            },
            "sync start"
        );
        try {
            await runSubscription(sub);
            log.info({ subId: sub.id }, "sync ok");
        } catch {
            // already logged inside
        }
    }
}

if (process.argv[1].endsWith("worker.js")) {
    runAll();
}
