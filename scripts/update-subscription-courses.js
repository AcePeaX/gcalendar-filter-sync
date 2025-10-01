// scripts/update-subscription-courses.js
import "dotenv/config";
import Database from "better-sqlite3";
import readline from "readline/promises";
import { stdin as input, stdout as output } from "node:process";

const db = new Database(process.env.DB_PATH || "./sync.db");

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

function updateFilters({ subId, filtersRaw, filterType, append }) {
    const sub = getSub(subId);
    if (!sub) throw new Error("Subscription not found");

    const newFilterType = filterType || sub.filter_type || "keywords";
    let newFiltersRaw = filtersRaw;
    if (append && sub.filters_raw) {
        const left = sub.filters_raw.trim();
        const right = filtersRaw.trim();
        newFiltersRaw = left && right ? `${left},${right}` : left || right;
    }

    db.prepare(
        `UPDATE subscriptions
     SET filter_type=?, filters_raw=?, updated_at=?
     WHERE id=?`
    ).run(newFilterType, newFiltersRaw, Date.now(), subId);

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

function parseArgs(argv) {
    // argv: [node, script, subId?, ...rest]
    const rest = argv.slice(2);
    const flags = new Set();
    const positionals = [];
    for (const t of rest) {
        if (t.startsWith("--")) flags.add(t);
        else positionals.push(t);
    }
    const subId = positionals.shift();
    const filters = positionals; // remaining are filters (space-separated entries; commas inside are fine)
    return { subId, filters, flags };
}

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
        const chosen = subs[idx - 1];

        const mode = await rl.question(
            "Filter mode? (k=keywords, r=regex) [k]: "
        );
        const filterType = (mode || "k").toLowerCase().startsWith("r")
            ? "regex"
            : "keywords";

        let filtersRaw = "";
        if (filterType === "keywords") {
            console.log(
                "Enter keywords (comma-separated). Example: Machine Learning, Optimal transport, Convex optimization"
            );
            filtersRaw = await rl.question("New filters: ");
        } else {
            console.log(
                "Enter a single regex (case-insensitive). Example: (Optimal Transport|Convex optimization)"
            );
            filtersRaw = await rl.question("Regex: ");
        }

        const appendAns = await rl.question(
            "Append to existing filters instead of replacing? (y/N): "
        );
        const append = appendAns.trim().toLowerCase().startsWith("y");

        const resyncAns = await rl.question(
            "Force resync (clear sync token & wipe mappings)? (y/N): "
        );
        const doResync = resyncAns.trim().toLowerCase().startsWith("y");

        const updated = updateFilters({
            subId: chosen.id,
            filtersRaw,
            filterType,
            append,
        });

        if (doResync) {
            clearSyncToken(chosen.id);
            wipeMappings(chosen.id);
            console.log(
                "🔁 Cleared sync token and mappings — next worker run will repopulate."
            );
        } else {
            // Still clear sync token so deltas are re-applied broadly
            clearSyncToken(chosen.id);
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

async function main() {
    const { subId, filters, flags } = parseArgs(process.argv);

    if (!subId) {
        // Interactive mode
        await interactive();
        return;
    }

    // Argv mode
    const append = flags.has("--append");
    const regex = flags.has("--regex");
    const resync = flags.has("--resync");

    if (filters.length === 0) {
        console.error(
            "Usage:\n  node scripts/update-subscription-courses.js <SUB_ID> [--append] [--regex] [--resync] <filters...>\n" +
                "\nExamples:\n" +
                "  # Replace filters (keywords):\n" +
                "  node scripts/update-subscription-courses.js 1234 'Optimal transport' 'Convex optimization'\n\n" +
                "  # Append filters (keywords):\n" +
                "  node scripts/update-subscription-courses.js 1234 --append 'Reinforcement Learning'\n\n" +
                "  # Use a regex:\n" +
                "  node scripts/update-subscription-courses.js 1234 --regex '(Optimal Transport|Convex optimization)'\n" +
                "  "
        );
        process.exit(1);
    }

    const filterType = regex ? "regex" : "keywords";
    const filtersRaw =
        filterType === "regex" ? filters.join(" ") : filters.join(",");

    const updated = updateFilters({
        subId,
        filtersRaw,
        filterType,
        append,
    });

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
