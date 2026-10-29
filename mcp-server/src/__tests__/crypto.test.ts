import { describe, it, expect, afterEach } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";
import { randomBytes } from "node:crypto";
import {
  encrypt,
  decrypt,
  encryptJSON,
  decryptJSON,
  deriveKey,
  initMasterKey,
} from "../collector/crypto.js";

const KEY = randomBytes(32);

describe("AES-256-GCM encrypt/decrypt", () => {
  it("round-trips a string", () => {
    const out = decrypt(encrypt("hello world", KEY), KEY).toString("utf-8");
    expect(out).toBe("hello world");
  });

  it("round-trips a buffer", () => {
    const data = randomBytes(1024);
    expect(decrypt(encrypt(data, KEY), KEY).equals(data)).toBe(true);
  });

  it("produces a distinct ciphertext for the same plaintext (random IV)", () => {
    const a = encrypt("same", KEY);
    const b = encrypt("same", KEY);
    expect(a.equals(b)).toBe(false); // IV differs each call
    expect(decrypt(a, KEY).toString()).toBe("same");
    expect(decrypt(b, KEY).toString()).toBe("same");
  });

  it("rejects a tampered ciphertext (GCM auth tag)", () => {
    const ct = encrypt("integrity matters", KEY);
    ct[ct.length - 1] ^= 0x01; // flip a ciphertext byte
    expect(() => decrypt(ct, KEY)).toThrow();
  });

  it("rejects a tampered auth tag", () => {
    const ct = encrypt("integrity matters", KEY);
    ct[13] ^= 0x01; // flip a byte inside the 16-byte tag (offset 12..27)
    expect(() => decrypt(ct, KEY)).toThrow();
  });

  it("rejects the wrong key", () => {
    const ct = encrypt("secret", KEY);
    expect(() => decrypt(ct, randomBytes(32))).toThrow();
  });

  it("throws on truncated input (shorter than iv+tag)", () => {
    expect(() => decrypt(randomBytes(10), KEY)).toThrow(/too short/i);
  });

  it("round-trips JSON", () => {
    const obj = { a: 1, b: ["x", "y"], c: { nested: true } };
    expect(decryptJSON(encryptJSON(obj, KEY), KEY)).toEqual(obj);
  });
});

describe("deriveKey", () => {
  it("is deterministic for the same passphrase + salt", () => {
    const salt = randomBytes(16);
    expect(deriveKey("pw", salt).equals(deriveKey("pw", salt))).toBe(true);
  });
  it("differs for a different salt", () => {
    expect(deriveKey("pw", randomBytes(16)).equals(deriveKey("pw", randomBytes(16)))).toBe(false);
  });
  it("returns a 32-byte key", () => {
    expect(deriveKey("pw", randomBytes(16)).length).toBe(32);
  });
});

describe("initMasterKey strict mode", () => {
  const saved = {
    require: process.env.MEMORIA_REQUIRE_ENCRYPTION_KEY,
    key: process.env.MEMORIA_ENCRYPTION_KEY,
  };
  afterEach(() => {
    process.env.MEMORIA_REQUIRE_ENCRYPTION_KEY = saved.require;
    process.env.MEMORIA_ENCRYPTION_KEY = saved.key;
  });

  it("fails closed when required but MEMORIA_ENCRYPTION_KEY is unset", () => {
    // NOTE: this must run before any successful initMasterKey() in this file,
    // since the module caches the key after the first success.
    process.env.MEMORIA_REQUIRE_ENCRYPTION_KEY = "true";
    delete process.env.MEMORIA_ENCRYPTION_KEY;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-key-"));
    expect(() => initMasterKey(dir)).toThrow(/MEMORIA_ENCRYPTION_KEY/);
    // It must NOT have written a key file to disk.
    expect(fs.existsSync(path.join(dir, "collector.key"))).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("keyedContentHash (review 2026-10: no reversible fingerprints on disk)", () => {
  it("is stable, keyed, and not the bare SHA-256", async () => {
    const { keyedContentHash, contentHash } = await import("../collector/crypto.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-khash-"));
    const envKey = process.env.MEMORIA_ENCRYPTION_KEY;
    delete process.env.MEMORIA_ENCRYPTION_KEY;
    try {
      const h = keyedContentHash("PIN 4821", dir);
      expect(h).toMatch(/^[0-9a-f]{64}$/);
      expect(h).toBe(keyedContentHash("PIN 4821", dir));
      expect(h).not.toBe(contentHash("PIN 4821"));
      expect(h).not.toBe(keyedContentHash("PIN 4822", dir));
    } finally {
      if (envKey !== undefined) process.env.MEMORIA_ENCRYPTION_KEY = envKey;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
