// scripts/update-subscription-courses.js
import "dotenv/config";
import Database from "better-sqlite3";
import readline from "readline/promises";
import { stdin as input, stdout as output } from "node:process";

const db = new Database(process.env.DB_PATH || "./sync.db");

/* ---------------- helpers ---------------- */

function normalize(s) {
    return (s || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "") // remove accents
        .replace(/\s+/g, " ")
        .trim();
}

function splitKeywords(raw) {
    return (raw || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
}

function uniquePreserveOrder(arr) {
    const seen = new Set();
    const out = [];
    for (const v of arr) {
        const key = normalize(v);
        if (!seen.has(key)) {
            seen.add(key);
            out.push(v);
        }
    }
    return out;
}

function getSub(id) {
    return db
        .prepare(
            `SELECT id, is_enabled, token_key, source_calendar_id, target_calendar_id, filter_type, filters_raw
       FROM subscriptions WHERE id=?`
        )
        .get(id);
}

function listSubs() {
    return db
        .prepare(
            `SELECT id, is_enabled, token_key, source_calendar_id, target_calendar_id, filter_type, filters_raw
       FROM subscriptions
       ORDER BY updated_at DESC`
        )
        .all();
}

function saveFilters({ subId, filterType, filtersRaw }) {
    db.prepare(
        `UPDATE subscriptions
     SET filter_type=?, filters_raw=?, updated_at=?
     WHERE id=?`
    ).run(filterType, filtersRaw, Date.now(), subId);
    return getSub(subId);
}

function clearSyncToken(subId) {
    db.prepare(
        `UPDATE subscription_state
     SET sync_token=NULL, last_status=NULL, last_run_at=NULL
     WHERE subscription_id=?`
    ).run(subId);
}

function wipeMappings(subId) {
    db.prepare(`DELETE FROM event_mappings WHERE subscription_id=?`).run(subId);
}

/* ------------- core ops for argv mode ------------- */

function doReplace({ subId, filterType, values }) {
    if (filterType === "regex") {
        const filtersRaw = values.join(" ");
        return saveFilters({ subId, filterType, filtersRaw });
    } else {
        const list = uniquePreserveOrder(values); // keywords
        const filtersRaw = list.join(",");
        return saveFilters({ subId, filterType: "keywords", filtersRaw });
    }
}

function doAppend({ subId, values }) {
    const sub = getSub(subId);
    if (!sub) throw new Error("Subscription not found");
    if (sub.filter_type === "regex") {
        throw new Error(
            "Cannot --append when filter type is regex. Use replace or switch to keywords."
        );
    }
    const existing = splitKeywords(sub.filters_raw);
    const merged = uniquePreserveOrder([...existing, ...values]);
    const filtersRaw = merged.join(",");
    return saveFilters({ subId, filterType: "keywords", filtersRaw });
}

function doRemove({ subId, removeValues }) {
    const sub = getSub(subId);
    if (!sub) throw new Error("Subscription not found");
    if (sub.filter_type === "regex") {
        throw new Error(
            "Cannot --remove on a regex subscription. Edit the regex instead."
        );
    }
    const existing = splitKeywords(sub.filters_raw);
    if (existing.length === 0) {
        return saveFilters({ subId, filterType: "keywords", filtersRaw: "" });
    }
    const removeSet = new Set(removeValues.map((v) => normalize(v)));
    const kept = existing.filter((kw) => !removeSet.has(normalize(kw)));
    const filtersRaw = kept.join(",");
    return saveFilters({ subId, filterType: "keywords", filtersRaw });
}

/* ---------------- argv parsing ---------------- */

function parseArgs(argv) {
    // argv: [node, script, ...]
    const rest = argv.slice(2);
    const flags = new Set();
    const positionals = [];
    for (const t of rest) {
        if (t.startsWith("--")) flags.add(t);
        else positionals.push(t);
    }
    const subId = positionals.shift();
    const values = positionals; // remaining are values (keywords or regex parts)
    return { subId, values, flags };
}

/* ---------------- interactive flow ---------------- */

async function interactive() {
    const rl = readline.createInterface({ input, output });
    try {
        const subs = listSubs();
        if (subs.length === 0) {
            console.log("No subscriptions found.");
            process.exit(0);
        }
        console.log("Subscriptions:");
        subs.forEach((s, i) => {
            console.log(
                `${i + 1}. ${s.id} | ${
                    s.is_enabled ? "ENABLED" : "disabled"
                } | ${s.token_key} | ${s.source_calendar_id} -> ${
                    s.target_calendar_id
                } | ${s.filter_type} | ${s.filters_raw}`
            );
        });

        const idxStr = await rl.question("\nPick a subscription number: ");
        const idx = Number(idxStr);
        if (!idx || idx < 1 || idx > subs.length) {
            console.error("Invalid selection.");
            process.exit(1);
        }
        const sub = subs[idx - 1];

        // choose operation
        console.log("\nWhat do you want to do?");
        console.log("  1) Replace filters");
        console.log("  2) Append keywords");
        console.log("  3) Remove keywords");
        const op = await rl.question("Select [1/2/3]: ");

        let updated;
        if (op === "1") {
            const mode = await rl.question(
                "Filter mode? (k=keywords, r=regex) [k]: "
            );
            const filterType = (mode || "k").toLowerCase().startsWith("r")
                ? "regex"
                : "keywords";
            let values = [];
            if (filterType === "keywords") {
                console.log(
                    "Enter keywords (comma-separated). Example: Machine Learning, Optimal transport, Convex optimization"
                );
                const raw = await rl.question("New keywords: ");
                values = splitKeywords(raw);
            } else {
                console.log(
                    "Enter a single regex (case-insensitive). Example: (Optimal Transport|Convex optimization)"
                );
                const raw = await rl.question("Regex: ");
                values = [raw];
            }
            updated = doReplace({ subId: sub.id, filterType, values });
        } else if (op === "2") {
            if (sub.filter_type === "regex") {
                console.log(
                    "Current mode is regex; cannot append keywords. Use Replace to switch to keywords."
                );
                process.exit(1);
            }
            console.log(
                `Current keywords:\n  ${
                    splitKeywords(sub.filters_raw)
                        .map((k, i) => `${i + 1}. ${k}`)
                        .join("\n  ") || "(none)"
                }`
            );
            const raw = await rl.question(
                "Keywords to append (comma-separated): "
            );
            const values = splitKeywords(raw);
            updated = doAppend({ subId: sub.id, values });
        } else if (op === "3") {
            if (sub.filter_type === "regex") {
                console.log(
                    "Current mode is regex; cannot remove keywords. Edit the regex in Replace."
                );
                process.exit(1);
            }
            const current = splitKeywords(sub.filters_raw);
            if (current.length === 0) {
                console.log("No keywords to remove.");
                process.exit(0);
            }
            console.log("Current keywords:");
            current.forEach((k, i) => console.log(`  ${i + 1}. ${k}`));
            const raw = await rl.question(
                "Type keywords or indices to remove (comma-separated). Example: 1,3 or Optimal transport, Convex optimization: "
            );

            // parse mixed indices/names
            const tokens = splitKeywords(raw); // comma-separated
            const byIndex = new Set();
            const byName = [];
            for (const t of tokens) {
                const n = Number(t);
                if (Number.isInteger(n) && n >= 1 && n <= current.length) {
                    byIndex.add(n - 1);
                } else {
                    byName.push(t);
                }
            }
            const removeNames = [
                ...byName,
                ...[...byIndex].map((i) => current[i]),
            ];
            updated = doRemove({ subId: sub.id, removeValues: removeNames });
        } else {
            console.error("Invalid selection.");
            process.exit(1);
        }

        const resyncAns = await rl.question(
            "Force resync (clear sync token & wipe mappings)? (y/N): "
        );
        const doResync = resyncAns.trim().toLowerCase().startsWith("y");
        if (doResync) {
            clearSyncToken(sub.id);
            wipeMappings(sub.id);
            console.log(
                "🔁 Cleared sync token and mappings — next worker run will repopulate."
            );
        } else {
            clearSyncToken(sub.id);
            console.log(
                "🔁 Cleared sync token — next worker run will re-scan with new filters."
            );
        }

        console.log("✅ Updated:");
        console.log(
            `${updated.id} | ${updated.filter_type} | ${updated.filters_raw}`
        );
    } finally {
        rl.close();
    }
}

/* ---------------- main (argv mode) ---------------- */

async function main() {
    const { subId, values, flags } = parseArgs(process.argv);

    if (!subId) {
        // Interactive mode
        await interactive();
        return;
    }

    const append = flags.has("--append");
    const regex = flags.has("--regex");
    const resync = flags.has("--resync");
    const remove = flags.has("--remove");

    // Validate combos
    if (remove && regex) {
        console.error(
            "Cannot combine --remove with --regex. Removing applies to keyword mode only."
        );
        process.exit(1);
    }

    if (values.length === 0) {
        console.error(
            "Usage:\n" +
                "  node scripts/update-subscription-courses.js <SUB_ID> [--append] [--remove] [--regex] [--resync] <values...>\n\n" +
                "Examples:\n" +
                "  # Replace with keywords:\n" +
                "  node scripts/update-subscription-courses.js 1234 'Optimal transport' 'Convex optimization'\n\n" +
                "  # Append keywords:\n" +
                "  node scripts/update-subscription-courses.js 1234 --append 'Reinforcement Learning'\n\n" +
                "  # Remove keywords (case/accents-insensitive):\n" +
                "  node scripts/update-subscription-courses.js 1234 --remove 'Optimal transport' 'Convex optimization'\n\n" +
                "  # Replace with a regex:\n" +
                "  node scripts/update-subscription-courses.js 1234 --regex '(Optimal Transport|Convex optimization)'\n" +
                ""
        );
        process.exit(1);
    }

    let updated;
    if (remove) {
        // remove from existing keywords list
        updated = doRemove({ subId, removeValues: values });
    } else if (append) {
        // append keywords
        updated = doAppend({ subId, values });
    } else {
        // replace (keywords or regex)
        const filterType = regex ? "regex" : "keywords";
        updated = doReplace({ subId, filterType, values });
    }

    if (resync) {
        clearSyncToken(subId);
        wipeMappings(subId);
        console.log(
            "🔁 Cleared sync token and mappings — next worker run will repopulate."
        );
    } else {
        clearSyncToken(subId);
        console.log(
            "🔁 Cleared sync token — next worker run will re-scan with new filters."
        );
    }

    console.log("✅ Updated:");
    console.log(
        `${updated.id} | ${updated.filter_type} | ${updated.filters_raw}`
    );
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
