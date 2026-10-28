/**
 * Encryption layer for sub-memory collector.
 * All data encrypted at rest and in transit by default.
 * Only the Memoria agent and the user have access.
 *
 * Uses AES-256-GCM for symmetric encryption (authenticated).
 * The master key is sourced, in order, from: the MEMORIA_ENCRYPTION_KEY env var
 * (hex; recommended — pin it from a secret manager), then a local key file at
 * <dataDir>/collector.key (owner-only 0600, auto-generated on first run). Set
 * MEMORIA_REQUIRE_ENCRYPTION_KEY=true to require the env var and refuse the
 * on-disk fallback. (deriveKey() offers scrypt passphrase derivation for
 * callers that want it, but the master-key bootstrap does not use a passphrase.)
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  scryptSync,
} from "node:crypto";
import * as fs from "node:fs";
import { sleepSync } from "../atomic-fs.js";
import * as path from "node:path";

const ALGO = "aes-256-gcm";
const KEY_LEN = 32; // 256 bits
const IV_LEN = 12; // 96-bit nonce for GCM
const TAG_LEN = 16; // 128-bit auth tag
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

// ── Key management ─────────────────────────────────────────

let _masterKey: Buffer | null = null;

/**
 * Derive a 256-bit key from a passphrase + salt.
 */
export function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
}

/**
 * Initialize or load the master encryption key.
 * Order of precedence:
 *   1. MEMORIA_ENCRYPTION_KEY env var (hex-encoded 32-byte key)
 *   2. Key file at <dataDir>/collector.key (auto-generated, owner-only 0600)
 *
 * When MEMORIA_REQUIRE_ENCRYPTION_KEY=true (recommended for any shared/cloud
 * deployment), only (1) is allowed: the function refuses to read or generate an
 * on-disk key. This prevents the master key from living on the same volume as
 * the ciphertext it protects, and from being silently regenerated (and thus
 * lost) on container restart.
 */
export function initMasterKey(dataDir: string): Buffer {
  if (_masterKey) return _masterKey;

  const requireEnvKey = process.env.MEMORIA_REQUIRE_ENCRYPTION_KEY === "true";

  // 1. Environment variable
  const envKey = process.env.MEMORIA_ENCRYPTION_KEY;
  if (envKey) {
    const buf = Buffer.from(envKey, "hex");
    if (buf.length !== KEY_LEN) {
      throw new Error(`MEMORIA_ENCRYPTION_KEY must be ${KEY_LEN * 2} hex chars (${KEY_LEN} bytes)`);
    }
    _masterKey = buf;
    return _masterKey;
  }

  // Fail closed: in strict mode we never derive the key from disk.
  if (requireEnvKey) {
    throw new Error(
      "MEMORIA_REQUIRE_ENCRYPTION_KEY=true but MEMORIA_ENCRYPTION_KEY is unset. " +
        "Supply the 64-hex-char master key from a secret manager — refusing to read " +
        "or auto-generate a key on shared storage (it would sit next to the ciphertext " +
        "and be lost on restart).",
    );
  }

  // 2. Key file
  const keyFile = path.join(dataDir, "collector.key");
  const existing = readKeyFile(keyFile);
  if (existing) {
    _masterKey = existing;
    return _masterKey;
  }

  // 3. Auto-generate
  if (process.env.DOCKER === "true") {
    process.stderr.write(
      "Memoria SECURITY: auto-generating an encryption key on disk in a container. " +
        "On a shared/cloud volume the key ends up beside the ciphertext it protects. " +
        "Set MEMORIA_ENCRYPTION_KEY (from a secret manager) and " +
        "MEMORIA_REQUIRE_ENCRYPTION_KEY=true for production.\n",
    );
  }
  const fresh = randomBytes(KEY_LEN);
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  try {
    // "wx" with mode 0600: owner-only from the first byte (writing first and
    // chmod-ing after left a window where a default umask made the key
    // world-readable), and never over an existing file. Two processes starting
    // together would otherwise each write their own key, and everything the
    // loser had encrypted would be unreadable for good. The loser reads the
    // winner's key instead.
    fs.writeFileSync(keyFile, fresh.toString("hex") + "\n", { flag: "wx", mode: 0o600 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    const winner = readKeyFile(keyFile);
    if (!winner) {
      throw new Error(`Encryption key file ${keyFile} vanished while being created`, {
        cause: err,
      });
    }
    _masterKey = winner;
    return _masterKey;
  }
  if (process.platform !== "win32" && (fs.statSync(keyFile).mode & 0o077) !== 0) {
    // FUSE and network mounts can ignore the requested mode.
    process.stderr.write(
      `Memoria: the filesystem did not apply mode 0600 to encryption key file ${keyFile}. ` +
        `SECURITY: ensure bucket/volume ACLs restrict access — the master key is at risk if the storage is readable.\n`,
    );
  }
  process.stderr.write(`Memoria: generated encryption key at ${keyFile}\n`);

  _masterKey = fresh;
  return _masterKey;
}

/**
 * Read and validate the on-disk master key; null when there is no key file.
 *
 * An empty file is another process between creating the key file and
 * writing it, so wait briefly for the content. Anything but 64 hex characters
 * is refused loudly: Buffer.from(hex, "hex") silently stops at the first
 * non-hex character, so a truncated or edited file used to yield a short key
 * and a baffling "Invalid key length" much later, at the first decrypt.
 */
function readKeyFile(keyFile: string): Buffer | null {
  for (let attempt = 0; ; attempt++) {
    let hex: string;
    try {
      hex = fs.readFileSync(keyFile, "utf-8").trim();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    if (hex === "" && attempt < 20) {
      sleepSync(50);
      continue;
    }
    if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== KEY_LEN * 2) {
      throw new Error(
        `Encryption key file ${keyFile} is not a valid key (expected ${KEY_LEN * 2} hex characters). ` +
          `Restore the original file: a new key cannot decrypt anything encrypted with the old one. ` +
          `If nothing was ever encrypted with it, delete the file and a new key is generated.`,
      );
    }
    return Buffer.from(hex, "hex");
  }
}

/**
 * Get the current master key. Throws if not initialized.
 */
export function getMasterKey(): Buffer {
  if (!_masterKey) throw new Error("Master key not initialized — call initMasterKey() first");
  return _masterKey;
}

// ── Encrypt / Decrypt ──────────────────────────────────────

/**
 * Encrypt a buffer or string with AES-256-GCM.
 * Returns: iv (12B) || authTag (16B) || ciphertext
 */
export function encrypt(plaintext: Buffer | string, key?: Buffer): Buffer {
  const k = key ?? getMasterKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, k, iv);

  const input = typeof plaintext === "string" ? Buffer.from(plaintext, "utf-8") : plaintext;

  const encrypted = Buffer.concat([cipher.update(input), cipher.final()]);
  const tag = cipher.getAuthTag();

  // iv || tag || ciphertext
  return Buffer.concat([iv, tag, encrypted]);
}

/**
 * Decrypt a buffer produced by encrypt().
 * Input format: iv (12B) || authTag (16B) || ciphertext
 */
export function decrypt(data: Buffer, key?: Buffer): Buffer {
  const k = key ?? getMasterKey();

  if (data.length < IV_LEN + TAG_LEN) {
    throw new Error("Encrypted data too short");
  }

  const iv = data.subarray(0, IV_LEN);
  const tag = data.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = data.subarray(IV_LEN + TAG_LEN);

  const decipher = createDecipheriv(ALGO, k, iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Encrypt a JSON-serializable object. Returns base64-encoded string.
 */
export function encryptJSON(obj: unknown, key?: Buffer): string {
  const json = JSON.stringify(obj);
  return encrypt(json, key).toString("base64");
}

/**
 * Decrypt a base64 string back to a parsed object.
 */
export function decryptJSON<T = unknown>(encoded: string, key?: Buffer): T {
  const buf = Buffer.from(encoded, "base64");
  const json = decrypt(buf, key).toString("utf-8");
  return JSON.parse(json) as T;
}

/**
 * Hash content for dedup (not encryption — one-way). Only for values that
 * never leave memory: a bare hash of short or templated personal content
 * (a PIN, an SSN in a known sentence) can be reversed by guessing.
 */
export function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

let _hashKey: { master: Buffer; key: Buffer } | null = null;

/**
 * A keyed fingerprint of content, for fingerprints that are written down:
 * the ingest dedup sidecar, provenance records, and content-derived event
 * ids (which reach the synced daily log as `ref:` pointers). HMAC-SHA256
 * under a subkey of the collector master key, so a fingerprint cannot be
 * checked against guesses without the key. Initialises the master key from
 * `dataDir` when nothing has yet.
 */
export function keyedContentHash(content: string, dataDir?: string): string {
  const master = _masterKey ?? (dataDir ? initMasterKey(dataDir) : getMasterKey());
  if (!_hashKey || _hashKey.master !== master) {
    const key = Buffer.from(
      hkdfSync("sha256", master, Buffer.alloc(0), "memoria/content-fingerprint/v1", 32),
    );
    _hashKey = { master, key };
  }
  return createHmac("sha256", _hashKey.key).update(content).digest("hex");
}
