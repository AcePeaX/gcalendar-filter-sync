// auth-helper-store.js (no userinfo call)
import "dotenv/config";
import { google } from "googleapis";
import { createTokenStore } from "./tokenStore.js";

const {
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI,
    TOKENSTORE_SECRET, // must be set
} = process.env;

if (!TOKENSTORE_SECRET || TOKENSTORE_SECRET.length < 16) {
    console.error("ERROR: TOKENSTORE_SECRET missing or too short.");
    process.exit(1);
}

const store = createTokenStore(process.env.TOKENSTORE_DIR || "./secure_tokens");

const oauth2 = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
);

// calendar-only scope works fine now
const scopes = ["https://www.googleapis.com/auth/calendar"];

const url = oauth2.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: scopes,
});

console.log("Open this URL and authorize:\n\n" + url + "\n");
console.log(
    "Then paste the ?code=... like:\n  node auth-helper-store.js <CODE> [ID_KEY]\n"
);

if (process.argv[2]) {
    const code = process.argv[2];
    const idKey = process.argv[3] || "google_default";

    console.log("code:", code);
    console.log("idKey:", idKey);

    (async () => {
        const { tokens } = await oauth2.getToken(code);
        oauth2.setCredentials(tokens);

        if (!tokens.refresh_token) {
            console.warn(
                "No refresh_token returned. Revoke prior consent at https://myaccount.google.com/permissions and try again."
            );
        }

        const payload = {
            provider: "google",
            scopes,
            tokens: {
                refresh_token: tokens.refresh_token,
                expiry_date: tokens.expiry_date,
                token_type: tokens.token_type,
            },
            issued_at: Date.now(),
        };

        await store.save(idKey, payload);

        console.log("\n✅ Stored credentials under key:", idKey);
        console.log(
            "   Location:",
            process.env.TOKENSTORE_DIR || "./secure_tokens"
        );
    })().catch((e) => {
        console.error("Failed to store tokens:", e?.message || e);
        process.exit(1);
    });
}
