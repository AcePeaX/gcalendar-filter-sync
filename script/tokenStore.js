// Secure per-user secret store: encrypts JSON payloads, locks file perms (0600), atomic writes.
// Requirements:
//   - process.env.TOKENSTORE_SECRET (>= 32 chars recommended)

import fs from "fs";
import path from "path";
import crypto from "crypto";

const ALG = "aes-256-gcm";
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const SCRYPT_N = 1 << 15; // 32768
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const FILE_MODE = 0o600; // -rw-------
const DIR_MODE = 0o700; // drwx------
const VERSION = 1;

/** Derive a 32-byte key from passphrase + salt using scrypt */
function deriveKey(passphrase, salt) {
    return new Promise((resolve, reject) => {
        crypto.scrypt(
            passphrase,
            salt,
            32,
            { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 256 * 1024 * 1024 },
            (err, key) => {
                if (err) reject(err);
                else resolve(key);
            }
        );
    });
}

/** Ensure directory exists with 0700 (and fix perms if needed) */
function ensureDirSecure(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    }
    try {
        fs.chmodSync(dir, DIR_MODE);
    } catch {
        /* ignore on non-POSIX */
    }
}

/** Atomic write: write tmp then rename */
function atomicWrite(filePath, buf) {
    const dir = path.dirname(filePath);
    const tmp = path.join(
        dir,
        `.tmp-${path.basename(filePath)}-${crypto
            .randomBytes(6)
            .toString("hex")}`
    );
    fs.writeFileSync(tmp, buf, { mode: FILE_MODE });
    try {
        fs.chmodSync(tmp, FILE_MODE);
    } catch {}
    fs.renameSync(tmp, filePath);
    try {
        fs.chmodSync(filePath, FILE_MODE);
    } catch {}
}

/** Build safe file path for an id */
function fileFor(storeDir, id) {
    // Basic sanitization to avoid path traversal
    const safe = String(id).replace(/[^a-zA-Z0-9._-]/g, "_");
    return path.join(storeDir, `${safe}.json`);
}

/** Encrypt a JS object -> Buffer (JSON) */
async function encrypt(passphrase, dataObj) {
    const salt = crypto.randomBytes(SALT_BYTES);
    const key = await deriveKey(passphrase, salt);
    const nonce = crypto.randomBytes(NONCE_BYTES);

    const cipher = crypto.createCipheriv(ALG, key, nonce);
    const plaintext = Buffer.from(JSON.stringify(dataObj), "utf8");
    const ciphertext = Buffer.concat([
        cipher.update(plaintext),
        cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    const payload = {
        v: VERSION,
        alg: ALG,
        salt: salt.toString("base64"),
        nonce: nonce.toString("base64"),
        ct: ciphertext.toString("base64"),
        tag: tag.toString("base64"),
    };
    return Buffer.from(JSON.stringify(payload), "utf8");
}

/** Decrypt Buffer(JSON) -> JS object */
async function decrypt(passphrase, buf) {
    const payload = JSON.parse(buf.toString("utf8"));
    if (payload.v !== VERSION)
        throw new Error("Unsupported token file version");
    const salt = Buffer.from(payload.salt, "base64");
    const nonce = Buffer.from(payload.nonce, "base64");
    const ct = Buffer.from(payload.ct, "base64");
    const tag = Buffer.from(payload.tag, "base64");

    const key = await deriveKey(passphrase, salt);
    const decipher = crypto.createDecipheriv(ALG, key, nonce);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]);
    return JSON.parse(plaintext.toString("utf8"));
}

/**
 * Initialize a store in `storeDir`.
 * Ensures directory and returns a small API for save/load/list/remove.
 */
export function createTokenStore(storeDir = "./secure_tokens") {
    const secret = process.env.TOKENSTORE_SECRET;
    if (!secret || secret.length < 16) {
        throw new Error(
            "TOKENSTORE_SECRET missing or too short. Set a strong secret in env."
        );
    }
    ensureDirSecure(storeDir);

    return {
        /** Save (encrypt) a payload under id. Payload can be any JSON-serializable object. */
        async save(id, payload) {
            const file = fileFor(storeDir, id);
            const enc = await encrypt(secret, payload);
            atomicWrite(file, enc);
            return true;
        },

        /** Load (decrypt) payload by id. Returns null if not found. */
        async load(id) {
            const file = fileFor(storeDir, id);
            if (!fs.existsSync(file)) return null;
            const buf = fs.readFileSync(file);
            return await decrypt(secret, buf);
        },

        /** Remove a stored secret by id (if exists). */
        remove(id) {
            const file = fileFor(storeDir, id);
            if (fs.existsSync(file)) fs.rmSync(file, { force: true });
            return true;
        },

        /** List all ids present in the store. */
        listIds() {
            const files = fs
                .readdirSync(storeDir, { withFileTypes: true })
                .filter((d) => d.isFile() && d.name.endsWith(".json"))
                .map((d) => d.name.replace(/\.json$/, ""));
            return files;
        },

        /** Tighten permissions again (useful after moves/backups). */
        harden() {
            ensureDirSecure(storeDir);
            for (const name of fs.readdirSync(storeDir)) {
                const p = path.join(storeDir, name);
                try {
                    fs.chmodSync(p, FILE_MODE);
                } catch {}
            }
            return true;
        },
    };
}
