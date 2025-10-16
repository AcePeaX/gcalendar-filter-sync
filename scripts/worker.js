// scripts/worker.js
import "dotenv/config";
import pino from "pino";
import Database from "better-sqlite3";
import { google } from "googleapis";
import crypto from "node:crypto";
import { createTokenStore } from "./tokenStore.js";

const log = pino({ level: process.env.LOG_LEVEL || "info" });

const DB_PATH = process.env.DB_PATH || "./sync.db";
const db = new Database(DB_PATH);
const store = createTokenStore(process.env.TOKENSTORE_DIR || "./secure_tokens");

const DEDUP_MATCH_FILTERS_ONLY = process.env.DEDUP_MATCH_FILTERS_ONLY === "1";

// ---------- helpers ----------
function oauthForTokenKey(tokenKey) {
    db.prepare("SELECT 1").get(); // ensure DB open
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

/** recurring helpers */
const isRecurringMaster = (ev) =>
    Array.isArray(ev.recurrence) && !ev.recurringEventId;
const isInstanceOrSingle = (ev) =>
    !Array.isArray(ev.recurrence) || !!ev.recurringEventId;

/** accent/space-insensitive normalizer */
function normalize(s) {
    return (s || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .replace(/\s+/g, " ")
        .trim();
}

function makeMatcher(filter_type, filters_raw) {
    if (filter_type === "regex") {
        const re = new RegExp(filters_raw, "i");
        return (ev) =>
            re.test(ev.summary || "") ||
            re.test(ev.description || "") ||
            re.test(ev.location || "");
    }
    const keys = filters_raw
        .split(",")
        .map((s) => normalize(s))
        .filter(Boolean);
    return (ev) => {
        const blob = normalize(
            `${ev.summary || ""} ${ev.description || ""} ${ev.location || ""}`
        );
        return keys.some((k) => blob.includes(k));
    };
}

async function listChanges(calendar, calId, params) {
    const res = await calendar.events.list({
        calendarId: calId,
        showDeleted: true,
        singleEvents: false, // deltas include masters + exceptions; we will skip masters as targets
        maxResults: 2500,
        ...params,
    });
    return res.data;
}

/* -------------------- fingerprinted payload -------------------- */

function stableStringify(obj) {
    // deterministic stringify (sort keys deep, break cycles)
    const seen = new WeakSet();
    const sortDeep = (v) => {
        if (v && typeof v === "object") {
            if (seen.has(v)) return null; // should not happen for Google event payloads
            seen.add(v);
            if (Array.isArray(v)) return v.map(sortDeep);
            return Object.fromEntries(
                Object.keys(v)
                    .sort()
                    .map((k) => [k, sortDeep(v[k])])
            );
        }
        return v;
    };
    return JSON.stringify(sortDeep(obj));
}

function fingerprintOfPayload(payload) {
    return crypto
        .createHash("sha1")
        .update(stableStringify(payload))
        .digest("hex");
}

/** Build exactly what we mirror to target. Extend if you want to track more fields. */
function buildPayloadFromSource(ev) {
    return {
        summary: ev.summary ?? null,
        description: ev.description ?? null, // “note”
        location: ev.location ?? null,
        start: ev.start, // {date} or {dateTime,timeZone}
        end: ev.end,
        reminders: ev.reminders?.useDefault
            ? { useDefault: true }
            : ev.reminders ?? undefined,
        transparency: ev.transparency || "opaque",
        // If needed, also mirror these and they’ll be fingerprinted:
        // colorId: ev.colorId ?? undefined,
        // visibility: ev.visibility ?? undefined,
        // attendees: ev.attendees ?? undefined,
        // extendedProperties: ev.extendedProperties ?? undefined,
    };
}

/* -------------------- CRUD in target -------------------- */

async function upsertTarget(
    calendar,
    subId,
    targetCalId,
    ev,
    forceUpdate = false
) {
    const existing = db
        .prepare(
            `SELECT * FROM event_mappings WHERE subscription_id=? AND source_id=?`
        )
        .get(subId, ev.id);

    const payload = buildPayloadFromSource(ev);
    const fp = fingerprintOfPayload(payload);

    if (existing) {
        const contentChanged = existing.fingerprint !== fp;
        const etagChanged = existing.etag !== ev.etag;

        if (contentChanged || etagChanged || forceUpdate) {
            const updated = await calendar.events.update({
                calendarId: targetCalId,
                eventId: existing.target_id,
                requestBody: payload,
            });
            db.prepare(
                `INSERT INTO event_mappings(subscription_id,source_id,target_id,etag,fingerprint)
         VALUES(?,?,?,?,?)
         ON CONFLICT(subscription_id,source_id)
         DO UPDATE SET target_id=excluded.target_id,
                       etag=excluded.etag,
                       fingerprint=excluded.fingerprint`
            ).run(subId, ev.id, updated.data.id, ev.etag, fp);
            log.debug({ subId, ev: ev.id }, "updated");
            return { updated: 1, created: 0, removed: 0 };
        }
        return { updated: 0, created: 0, removed: 0 };
    } else {
        const created = await calendar.events.insert({
            calendarId: targetCalId,
            requestBody: payload,
        });
        db.prepare(
            `INSERT INTO event_mappings(subscription_id,source_id,target_id,etag,fingerprint)
       VALUES(?,?,?,?,?)`
        ).run(subId, ev.id, created.data.id, ev.etag, fp);
        log.debug({ subId, ev: ev.id }, "created");
        return { updated: 0, created: 1, removed: 0 };
    }
}

async function removeTarget(calendar, subId, targetCalId, sourceId) {
    const row = db
        .prepare(
            `SELECT * FROM event_mappings WHERE subscription_id=? AND source_id=?`
        )
        .get(subId, sourceId);
    if (!row) return { removed: 0 };

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
    return { removed: 1 };
}

/* -------------------- window backfill / prune / dedupe -------------------- */

async function backfillWindow(calendar, sub, match) {
    const daysAhead = Number(process.env.BACKFILL_AHEAD_DAYS || 180);
    const daysBehind = Number(process.env.BACKFILL_BEHIND_DAYS || 7);
    const timeMin = new Date(
        Date.now() - daysBehind * 24 * 3600 * 1000
    ).toISOString();
    const timeMax = new Date(
        Date.now() + daysAhead * 24 * 3600 * 1000
    ).toISOString();

    let pageToken = undefined;
    let created = 0,
        updated = 0;

    do {
        const { data } = await calendar.events.list({
            calendarId: sub.source_calendar_id,
            singleEvents: true, // expand to instances
            orderBy: "startTime",
            timeMin,
            timeMax,
            maxResults: 2500,
            pageToken,
        });

        for (const ev of data.items || []) {
            // instances-only strategy: expanded instances have recurringEventId; singles have no recurrence
            if (!isInstanceOrSingle(ev)) continue;
            if (match(ev)) {
                const res = await upsertTarget(
                    calendar,
                    sub.id,
                    sub.target_calendar_id,
                    ev
                );
                created += res.created;
                updated += res.updated;
            }
        }

        pageToken = data.nextPageToken || undefined;
    } while (pageToken);

    return { created, updated };
}

async function pruneStaleMappings(calendar, sub, match) {
    const mapped = db
        .prepare(`SELECT source_id FROM event_mappings WHERE subscription_id=?`)
        .all(sub.id);

    let removed = 0;

    for (const row of mapped) {
        try {
            const { data: ev } = await calendar.events.get({
                calendarId: sub.source_calendar_id,
                eventId: row.source_id,
            });

            // if source is cancelled OR is a recurring master OR no longer matches → remove mirror
            if (
                ev.status === "cancelled" ||
                isRecurringMaster(ev) ||
                !match(ev)
            ) {
                const r = await removeTarget(
                    calendar,
                    sub.id,
                    sub.target_calendar_id,
                    row.source_id
                );
                removed += r.removed;
            }
        } catch (e) {
            if (e?.code === 404) {
                const r = await removeTarget(
                    calendar,
                    sub.id,
                    sub.target_calendar_id,
                    row.source_id
                );
                removed += r.removed;
            } else {
                throw e;
            }
        }
    }

    return { removed };
}

/** Remove any event in target calendar that isn't mapped to this subscription.
 * If DEDUP_MATCH_FILTERS_ONLY=1, only remove unmapped events that also match filters.
 */
async function dedupeTarget(calendar, sub, match) {
    const valid = new Set(
        db
            .prepare(
                `SELECT target_id FROM event_mappings WHERE subscription_id=?`
            )
            .all(sub.id)
            .map((r) => r.target_id)
    );

    let removed = 0;
    let pageToken = undefined;

    do {
        const { data } = await calendar.events.list({
            calendarId: sub.target_calendar_id,
            showDeleted: false,
            singleEvents: false,
            maxResults: 2500,
            pageToken,
        });

        for (const ev of data.items || []) {
            const id = ev.id;
            const isMapped = valid.has(id);

            if (!isMapped && (!DEDUP_MATCH_FILTERS_ONLY || match(ev))) {
                try {
                    await calendar.events.delete({
                        calendarId: sub.target_calendar_id,
                        eventId: id,
                    });
                    removed++;
                    log.debug({ subId: sub.id, targetId: id }, "dedup removed");
                } catch (e) {
                    if (e?.code !== 404) throw e;
                }
            }
        }

        pageToken = data.nextPageToken || undefined;
    } while (pageToken);

    return { removed };
}

/* -------------------- master-change refresh -------------------- */

async function refreshSeriesForMasterChange(calendar, sub, masterEv, match) {
    const daysAhead = Number(process.env.BACKFILL_AHEAD_DAYS || 180);
    const daysBehind = Number(process.env.BACKFILL_BEHIND_DAYS || 7);
    const timeMin = new Date(
        Date.now() - daysBehind * 24 * 3600 * 1000
    ).toISOString();
    const timeMax = new Date(
        Date.now() + daysAhead * 24 * 3600 * 1000
    ).toISOString();

    let pageToken;
    let created = 0,
        updated = 0,
        removed = 0;

    do {
        const { data } = await calendar.events.instances({
            calendarId: sub.source_calendar_id,
            eventId: masterEv.id,
            timeMin,
            timeMax,
            maxResults: 2500,
            pageToken,
        });

        for (const inst of data.items || []) {
            if (!isInstanceOrSingle(inst)) continue;

            if (match(inst)) {
                const res = await upsertTarget(
                    calendar,
                    sub.id,
                    sub.target_calendar_id,
                    inst,
                    /* forceUpdate */ true
                );
                created += res.created;
                updated += res.updated;
            } else {
                const r = await removeTarget(
                    calendar,
                    sub.id,
                    sub.target_calendar_id,
                    inst.id
                );
                removed += r.removed;
            }
        }

        pageToken = data.nextPageToken || undefined;
    } while (pageToken);

    return { created, updated, removed };
}

/* -------------------- subscription runner -------------------- */

async function runSubscription(sub) {
    const oauth2 = await oauthForTokenKey(sub.token_key);
    const calendar = google.calendar({ version: "v3", auth: oauth2 });
    const match = makeMatcher(sub.filter_type, sub.filters_raw);

    const state = db
        .prepare("SELECT * FROM subscription_state WHERE subscription_id=?")
        .get(sub.id);

    let pageToken = undefined;
    let created = 0,
        updated = 0,
        removed = 0;

    const saveState = (patch) => {
        db.prepare(
            `INSERT INTO subscription_state(subscription_id,sync_token,last_run_at,last_status)
       VALUES(?,?,?,?)
       ON CONFLICT(subscription_id) DO UPDATE SET
         sync_token=COALESCE(excluded.sync_token, subscription_state.sync_token),
         last_run_at=COALESCE(excluded.last_run_at, subscription_state.last_run_at),
         last_status=COALESCE(excluded.last_status, subscription_state.last_status)`
        ).run(
            sub.id,
            patch.sync_token ?? null,
            patch.last_run_at ?? Date.now(),
            patch.last_status ?? "ok"
        );
    };

    try {
        // --- Incremental changes (masters trigger series refresh) ---
        do {
            const data = await listChanges(calendar, sub.source_calendar_id, {
                pageToken,
                ...(state?.sync_token ? { syncToken: state.sync_token } : {}),
            });

            for (const ev of data.items || []) {
                if (ev.status === "cancelled") {
                    const r = await removeTarget(
                        calendar,
                        sub.id,
                        sub.target_calendar_id,
                        ev.id
                    );
                    removed += r.removed;
                    continue;
                }

                if (isRecurringMaster(ev)) {
                    // Master changed → refresh its instances within our window
                    const ref = await refreshSeriesForMasterChange(
                        calendar,
                        sub,
                        ev,
                        match
                    );
                    created += ref.created;
                    updated += ref.updated;
                    removed += ref.removed;

                    // Also ensure we never keep a mirrored master (legacy safety)
                    const r = await removeTarget(
                        calendar,
                        sub.id,
                        sub.target_calendar_id,
                        ev.id
                    );
                    removed += r.removed;
                    continue;
                }

                if (isInstanceOrSingle(ev) && match(ev)) {
                    const res = await upsertTarget(
                        calendar,
                        sub.id,
                        sub.target_calendar_id,
                        ev
                    );
                    created += res.created;
                    updated += res.updated;
                } else {
                    const r = await removeTarget(
                        calendar,
                        sub.id,
                        sub.target_calendar_id,
                        ev.id
                    );
                    removed += r.removed;
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

        // --- BACKFILL instances in a time window ---
        const bf = await backfillWindow(calendar, sub, match);
        created += bf.created;
        updated += bf.updated;

        // --- PRUNE mapped items that are now invalid (incl. masters) ---
        const prune = await pruneStaleMappings(calendar, sub, match);
        removed += prune.removed;

        // --- DEDUPE anything not mapped to this subscription ---
        const dedup = await dedupeTarget(calendar, sub, match);
        removed += dedup.removed;
    } catch (e) {
        if (e?.code === 410) {
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
        saveState({ last_status: "error" });
        throw e;
    }

    log.info({ subId: sub.id, created, updated, removed }, "delta");
    saveState({ last_status: "ok" });
}

async function runAll() {
    const subs = db
        .prepare(`SELECT * FROM subscriptions WHERE is_enabled=1`)
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
            // already logged
        }
    }
}

if (process.argv[1].endsWith("worker.js")) {
    runAll();
}
