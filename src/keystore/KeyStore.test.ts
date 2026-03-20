/**
 * KeyStore unit tests.
 *
 * Tests cover:
 *   - Initialisation (new store creation)
 *   - Unlock/lock lifecycle
 *   - Wrong passphrase rejection
 *   - Key add / get / list / delete / rotate
 *   - Signature building (real-time and session modes)
 *   - Persistence across instances (reload from disk)
 *   - Edge cases: double-add, missing key, locked access
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keccak256, toBytes } from 'viem';
import { KeyStore } from './KeyStore.js';
import { readFileSync } from 'node:fs';

// ── Test helpers ───────────────────────────────────────────────────────────

const TEST_DIR      = join(tmpdir(), 'echo-keystore-test');
const PASSPHRASE    = 'test-passphrase-not-secure';
const INSTANCE_ID   = '0x' + 'ab'.repeat(32);
const SESSION_ID    = '0x' + 'cd'.repeat(32);

function testPath(): string {
  return join(TEST_DIR, `keystore-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

// ── Test suite ─────────────────────────────────────────────────────────────

describe('KeyStore', () => {
  beforeEach(() => {
    if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // ── Lifecycle ────────────────────────────────────────────────────────────

  it('creates a new store file on first unlock', async () => {
    const path = testPath();
    const ks   = new KeyStore(path);
    await ks.unlock(PASSPHRASE);
    expect(existsSync(path)).toBe(true);
    expect(ks.isUnlocked).toBe(true);
  });

  it('lock() clears the encryption key from memory', async () => {
    const ks = new KeyStore(testPath());
    await ks.unlock(PASSPHRASE);
    expect(ks.isUnlocked).toBe(true);
    ks.lock();
    expect(ks.isUnlocked).toBe(false);
  });

  it('throws when accessing a locked store', async () => {
    const ks = new KeyStore(testPath());
    expect(() => ks.listKeys()).toThrow('not unlocked');
  });

  it('accepts correct passphrase on reload', async () => {
    const path = testPath();
    const ks1  = new KeyStore(path);
    await ks1.unlock(PASSPHRASE);
    await ks1.addKey(INSTANCE_ID, 'execute', 'agent');
    ks1.lock();

    const ks2 = new KeyStore(path);
    await expect(ks2.unlock(PASSPHRASE)).resolves.toBeUndefined();
    expect(ks2.isUnlocked).toBe(true);
  });

  it('rejects wrong passphrase', async () => {
    const path = testPath();
    const ks1  = new KeyStore(path);
    await ks1.unlock(PASSPHRASE);
    await ks1.addKey(INSTANCE_ID, 'execute', 'agent');
    ks1.lock();

    const ks2 = new KeyStore(path);
    await expect(ks2.unlock('wrong-passphrase')).rejects.toThrow('wrong passphrase');
  });

  // ── Key CRUD ─────────────────────────────────────────────────────────────

  it('addKey returns a rawKey and keyHash', async () => {
    const ks = new KeyStore(testPath());
    await ks.unlock(PASSPHRASE);

    const { rawKey, keyHash } = await ks.addKey(INSTANCE_ID, 'execute', 'agent');

    expect(rawKey).toMatch(/^0x[0-9a-f]{64}$/i);
    expect(keyHash).toMatch(/^0x[0-9a-f]{64}$/i);

    // Verify: keccak256(rawKey) === keyHash
    const expected = keccak256(toBytes(rawKey));
    expect(keyHash).toBe(expected);
  });

  it('getKey returns the same rawKey that was generated', async () => {
    const ks = new KeyStore(testPath());
    await ks.unlock(PASSPHRASE);

    const { rawKey } = await ks.addKey(INSTANCE_ID, 'execute', 'agent');
    const retrieved  = ks.getKey(INSTANCE_ID);

    expect(retrieved).toBe(rawKey);
  });

  it('getKey returns null for unknown id', async () => {
    const ks = new KeyStore(testPath());
    await ks.unlock(PASSPHRASE);
    expect(ks.getKey('0x' + 'ff'.repeat(32))).toBeNull();
  });

  it('hasKey returns true for existing key, false for missing', async () => {
    const ks = new KeyStore(testPath());
    await ks.unlock(PASSPHRASE);
    await ks.addKey(INSTANCE_ID, 'execute', 'agent');

    expect(ks.hasKey(INSTANCE_ID)).toBe(true);
    expect(ks.hasKey('0x' + 'ff'.repeat(32))).toBe(false);
  });

  it('addKey throws on duplicate id', async () => {
    const ks = new KeyStore(testPath());
    await ks.unlock(PASSPHRASE);
    await ks.addKey(INSTANCE_ID, 'execute', 'agent');
    await expect(ks.addKey(INSTANCE_ID, 'execute', 'agent2')).rejects.toThrow('already exists');
  });

  it('listKeys returns metadata without sensitive fields', async () => {
    const ks = new KeyStore(testPath());
    await ks.unlock(PASSPHRASE);
    await ks.addKey(INSTANCE_ID, 'execute', 'execute-label');
    await ks.addKey(SESSION_ID,  'session', 'session-label');

    const all     = ks.listKeys();
    const execKeys = ks.listKeys('execute');
    const sessKeys = ks.listKeys('session');

    expect(all).toHaveLength(2);
    expect(execKeys).toHaveLength(1);
    expect(sessKeys).toHaveLength(1);

    // No sensitive fields
    for (const meta of all) {
      expect(meta).not.toHaveProperty('encryptedKey');
      expect(meta).not.toHaveProperty('iv');
      expect(meta).not.toHaveProperty('authTag');
    }
  });

  it('deleteKey removes the key', async () => {
    const ks = new KeyStore(testPath());
    await ks.unlock(PASSPHRASE);
    await ks.addKey(INSTANCE_ID, 'execute', 'agent');
    await ks.deleteKey(INSTANCE_ID);

    expect(ks.hasKey(INSTANCE_ID)).toBe(false);
    expect(ks.getKey(INSTANCE_ID)).toBeNull();
  });

  it('deleteKey throws for unknown id', async () => {
    const ks = new KeyStore(testPath());
    await ks.unlock(PASSPHRASE);
    await expect(ks.deleteKey('0x' + 'ff'.repeat(32))).rejects.toThrow('not found');
  });

  it('rotateKey produces a new rawKey with updated hash', async () => {
    const ks = new KeyStore(testPath());
    await ks.unlock(PASSPHRASE);
    const { rawKey: oldKey, keyHash: oldHash } = await ks.addKey(INSTANCE_ID, 'execute', 'agent');

    const { rawKey: newKey, keyHash: newHash } = await ks.rotateKey(INSTANCE_ID);

    expect(newKey).not.toBe(oldKey);
    expect(newHash).not.toBe(oldHash);

    // New key should decrypt correctly
    expect(ks.getKey(INSTANCE_ID)).toBe(newKey);

    // keyHash in metadata should be updated
    const meta = ks.getKeyMeta(INSTANCE_ID);
    expect(meta?.keyHash).toBe(newHash);
  });

  // ── Persistence across instances ─────────────────────────────────────────

  it('key survives lock/unlock cycle (persisted on disk)', async () => {
    const path = testPath();
    const ks1  = new KeyStore(path);
    await ks1.unlock(PASSPHRASE);
    const { rawKey } = await ks1.addKey(INSTANCE_ID, 'execute', 'agent');
    ks1.lock();

    const ks2 = new KeyStore(path);
    await ks2.unlock(PASSPHRASE);
    expect(ks2.getKey(INSTANCE_ID)).toBe(rawKey);
  });

  it('multiple keys persist across reload', async () => {
    const path = testPath();
    const ks1  = new KeyStore(path);
    await ks1.unlock(PASSPHRASE);
    const { rawKey: k1 } = await ks1.addKey(INSTANCE_ID, 'execute', 'exec');
    const { rawKey: k2 } = await ks1.addKey(SESSION_ID,  'session', 'sess');
    ks1.lock();

    const ks2 = new KeyStore(path);
    await ks2.unlock(PASSPHRASE);
    expect(ks2.getKey(INSTANCE_ID)).toBe(k1);
    expect(ks2.getKey(SESSION_ID)).toBe(k2);
    expect(ks2.listKeys()).toHaveLength(2);
  });

  // ── Signature builders ────────────────────────────────────────────────────

  it('buildRealtimeSig produces 33-byte sig starting with 0x03 (7702 / validateFor7702)', async () => {
    const ks = new KeyStore(testPath());
    await ks.unlock(PASSPHRASE);
    await ks.addKey(INSTANCE_ID, 'execute', 'agent');

    const sig     = ks.buildRealtimeSig(INSTANCE_ID);
    const sigBytes = Buffer.from(sig.slice(2), 'hex');

    // 33 bytes total: 1 mode byte + 32 key bytes
    expect(sigBytes).toHaveLength(33);
    expect(sigBytes[0]).toBe(0x03);
  });

  it('buildRealtimeSig embeds the correct rawKey', async () => {
    const ks = new KeyStore(testPath());
    await ks.unlock(PASSPHRASE);
    const { rawKey } = await ks.addKey(INSTANCE_ID, 'execute', 'agent');

    const sig      = ks.buildRealtimeSig(INSTANCE_ID);
    const sigBytes = Buffer.from(sig.slice(2), 'hex');
    const keyInSig = '0x' + sigBytes.slice(1).toString('hex');

    expect(keyInSig).toBe(rawKey);
  });

  it('buildSessionSig produces 65-byte sig starting with 0x02', async () => {
    const ks = new KeyStore(testPath());
    await ks.unlock(PASSPHRASE);
    await ks.addKey(SESSION_ID, 'session', 'sess');

    const sig      = ks.buildSessionSig(SESSION_ID);
    const sigBytes = Buffer.from(sig.slice(2), 'hex');

    // 65 bytes: 1 mode + 32 sessionId + 32 key
    expect(sigBytes).toHaveLength(65);
    expect(sigBytes[0]).toBe(0x02);
  });

  it('buildSessionSig embeds sessionId and rawKey correctly', async () => {
    const ks = new KeyStore(testPath());
    await ks.unlock(PASSPHRASE);
    const { rawKey } = await ks.addKey(SESSION_ID, 'session', 'sess');

    const sig          = ks.buildSessionSig(SESSION_ID);
    const sigBytes     = Buffer.from(sig.slice(2), 'hex');
    const sidInSig     = '0x' + sigBytes.slice(1, 33).toString('hex');
    const keyInSig     = '0x' + sigBytes.slice(33).toString('hex');

    // sessionId bytes (strip 0x, lower case)
    const sidExpected  = SESSION_ID.toLowerCase();
    expect(sidInSig).toBe(sidExpected);
    expect(keyInSig).toBe(rawKey);
  });

  it('buildRealtimeSig throws for missing key', async () => {
    const ks = new KeyStore(testPath());
    await ks.unlock(PASSPHRASE);
    expect(() => ks.buildRealtimeSig(INSTANCE_ID)).toThrow('no execute key');
  });

  it('buildSessionSig throws for missing key', async () => {
    const ks = new KeyStore(testPath());
    await ks.unlock(PASSPHRASE);
    expect(() => ks.buildSessionSig(SESSION_ID)).toThrow('no session key');
  });

  // ── Security properties ───────────────────────────────────────────────────

  it('two stores with same passphrase but different salts encrypt differently', async () => {
    const p1 = testPath();
    const p2 = testPath();
    const ks1 = new KeyStore(p1);
    const ks2 = new KeyStore(p2);
    await ks1.unlock(PASSPHRASE);
    await ks2.unlock(PASSPHRASE);

    const { rawKey: k1 } = await ks1.addKey(INSTANCE_ID, 'execute', 'a');
    const { rawKey: k2 } = await ks2.addKey(INSTANCE_ID, 'execute', 'b');

    const f1 = JSON.parse(require('node:fs').readFileSync(p1, 'utf8'));
    const f2 = JSON.parse(require('node:fs').readFileSync(p2, 'utf8'));

    // KDF salts must differ
    expect(f1.kdfSalt).not.toBe(f2.kdfSalt);
    // Encrypted key bytes must differ even if raw keys happen to differ
    expect(f1.keys[0].encryptedKey).not.toBe(f2.keys[0].encryptedKey);
  });

  it('rotating a key changes the encrypted blob on disk', async () => {
    const path = testPath();
    const ks   = new KeyStore(path);
    await ks.unlock(PASSPHRASE);
    await ks.addKey(INSTANCE_ID, 'execute', 'agent');

    const before = JSON.parse(readFileSync(path, 'utf8') as string);
    await ks.rotateKey(INSTANCE_ID);
    const after  = JSON.parse(readFileSync(path, 'utf8') as string);

    expect(after.keys[0].encryptedKey).not.toBe(before.keys[0].encryptedKey);
    expect(after.keys[0].iv).not.toBe(before.keys[0].iv);
    expect(after.keys[0].keyHash).not.toBe(before.keys[0].keyHash);
  });
});
