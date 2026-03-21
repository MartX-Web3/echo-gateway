/**
 * KeyStore — encrypted local storage for Echo Protocol signing keys.
 *
 * Security design:
 *   - Keys are stored AES-256-GCM encrypted at rest.
 *   - Encryption key is derived from a passphrase using PBKDF2-SHA256
 *     (310,000 iterations — NIST 2023 recommendation for SHA-256).
 *   - Each stored key has its own random 12-byte IV and 16-byte auth tag.
 *   - The raw key is only in memory during the window it is actively needed.
 *   - keccak256(rawKey) is stored in clear — it is already public on-chain.
 *
 * File format: JSON at KEYSTORE_PATH (default: ~/.echo/keystore.json).
 *   {
 *     version: 1,
 *     kdfSalt: "<base64 32 bytes>",
 *     keys: [ { id, type, label, encryptedKey, iv, authTag, keyHash, ... } ]
 *   }
 *
 * Thread safety: all mutations acquire a simple async mutex (write-then-flush).
 * This is sufficient for a single-process local gateway.
 */

import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { keccak256, toBytes, toHex } from 'viem';
import type { KeyStoreFile, StoredKey, RawKey, KeyHash, KeyType } from './types.js';

// ── Constants ──────────────────────────────────────────────────────────────

const KEYSTORE_VERSION = 1 as const;
const AES_ALGO         = 'aes-256-gcm' as const;
const KDF_ALGO         = 'sha256' as const;
const KDF_ITERATIONS   = 310_000;
const KDF_KEY_LEN      = 32; // bytes → 256-bit AES key
const IV_LEN           = 12; // bytes — recommended for AES-GCM
const SALT_LEN         = 32; // bytes — KDF salt
const TAG_LEN          = 16; // bytes — AES-GCM auth tag

// ── KeyStore class ─────────────────────────────────────────────────────────

export class KeyStore {
  readonly path: string;  // exposed for context.json storage
  private encKey: Buffer | null = null;
  private store: KeyStoreFile | null = null;
  private writeLock = false;

  constructor(path: string) {
    this.path = path;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  /**
   * Unlock the KeyStore with a passphrase.
   * - If the store file does not exist, it is initialised (new install).
   * - If it exists, the passphrase is verified by attempting to decrypt
   *   the first key. If no keys exist yet, the KDF parameters are trusted.
   *
   * @throws if the store file exists but the passphrase is wrong.
   */
  async unlock(passphrase: string): Promise<void> {
    if (!existsSync(this.path)) {
      await this._initialise(passphrase);
      return;
    }

    const raw = readFileSync(this.path, 'utf8');
    this.store = JSON.parse(raw) as KeyStoreFile;

    if (this.store.version !== KEYSTORE_VERSION) {
      throw new Error(`KeyStore: unsupported version ${this.store.version}`);
    }

    const salt = Buffer.from(this.store.kdfSalt, 'base64');
    this.encKey = pbkdf2Sync(passphrase, salt, KDF_ITERATIONS, KDF_KEY_LEN, KDF_ALGO);

    // Verify passphrase by attempting to decrypt the first key (if any).
    if (this.store.keys.length > 0) {
      const first = this.store.keys[0]!;
      try {
        this._decryptKey(first);
      } catch {
        this.encKey = null;
        this.store = null;
        throw new Error('KeyStore: wrong passphrase');
      }
    }
  }

  /**
   * Lock the KeyStore — wipes the encryption key from memory.
   */
  lock(): void {
    if (this.encKey) {
      this.encKey.fill(0);
      this.encKey = null;
    }
    this.store = null;
  }

  get isUnlocked(): boolean {
    return this.encKey !== null && this.store !== null;
  }

  // ── Key management ─────────────────────────────────────────────────────

  /**
   * Store a new key.
   * - Generates a cryptographically random 32-byte raw key.
   * - Encrypts it with AES-256-GCM using the derived enc key.
   * - Returns the raw key (caller is responsible for handling it safely)
   *   and the keyHash (keccak256(rawKey)) to register on-chain.
   *
   * @param id       instanceId (execute key) or sessionId (session key)
   * @param type     'execute' or 'session'
   * @param label    human-readable label for the Dashboard
   * @param options  optional expiresAt timestamp (ms)
   */
  async addKey(
    id: string,
    type: KeyType,
    label: string,
    options?: { expiresAt?: number },
  ): Promise<{ rawKey: RawKey; keyHash: KeyHash }> {
    this._assertUnlocked();

    if (this._findKey(id) !== undefined) {
      throw new Error(`KeyStore: key already exists for id="${id}"`);
    }

    // Generate random 32-byte key
    const rawBytes = randomBytes(32);
    const rawKey   = toHex(rawBytes) as RawKey;
    const keyHash  = keccak256(toBytes(rawKey)) as KeyHash;

    // Encrypt
    const { encryptedKey, iv, authTag } = this._encryptKey(rawKey);

    const stored: StoredKey = {
      id,
      type,
      label,
      encryptedKey,
      iv,
      authTag,
      keyHash,
      createdAt: Date.now(),
      ...(options?.expiresAt !== undefined && { expiresAt: options.expiresAt }),
    };

    this.store!.keys.push(stored);
    await this._flush();

    return { rawKey, keyHash };
  }

  /**
   * Retrieve and decrypt a raw key by id.
   * Returns null if not found.
   *
   * The returned RawKey should be used immediately and not stored in
   * a long-lived variable.
   */
  getKey(id: string): RawKey | null {
    this._assertUnlocked();
    this._reloadStore();
    const stored = this._findKey(id);
    if (!stored) return null;
    return this._decryptKey(stored);
  }

  /**
   * Get metadata for a key (without decrypting the raw key).
   */
  getKeyMeta(id: string): Omit<StoredKey, 'encryptedKey' | 'iv' | 'authTag'> | null {
    this._assertUnlocked();
    this._reloadStore();
    const stored = this._findKey(id);
    if (!stored) return null;
    const { encryptedKey: _e, iv: _i, authTag: _a, ...meta } = stored;
    return meta;
  }

  /**
   * List all key metadata (no raw keys).
   */
  listKeys(type?: KeyType): Omit<StoredKey, 'encryptedKey' | 'iv' | 'authTag'>[] {
    this._assertUnlocked();
    this._reloadStore();
    return this.store!.keys
      .filter(k => type === undefined || k.type === type)
      .map(({ encryptedKey: _e, iv: _i, authTag: _a, ...meta }) => meta);
  }

  /**
   * Rotate a key: generate a new raw key for an existing id.
   * Returns the new rawKey and keyHash (caller must re-register on-chain).
   */
  async rotateKey(id: string): Promise<{ rawKey: RawKey; keyHash: KeyHash }> {
    this._assertUnlocked();
    const stored = this._findKey(id);
    if (!stored) throw new Error(`KeyStore: key not found for id="${id}"`);

    const rawBytes = randomBytes(32);
    const rawKey   = toHex(rawBytes) as RawKey;
    const keyHash  = keccak256(toBytes(rawKey)) as KeyHash;

    const { encryptedKey, iv, authTag } = this._encryptKey(rawKey);

    stored.encryptedKey = encryptedKey;
    stored.iv           = iv;
    stored.authTag      = authTag;
    stored.keyHash      = keyHash;

    await this._flush();
    return { rawKey, keyHash };
  }

  /**
   * Delete a key by id.
   * @throws if not found.
   */
  async deleteKey(id: string): Promise<void> {
    this._assertUnlocked();
    const idx = this.store!.keys.findIndex(k => k.id === id);
    if (idx === -1) throw new Error(`KeyStore: key not found for id="${id}"`);
    this.store!.keys.splice(idx, 1);
    await this._flush();
  }

  /**
   * Rename a key's id (same raw key + keyHash). Used after on-chain registration
   * to promote a `pending:*` execute key to the real PolicyInstance bytes32 id.
   */
  async renameKeyId(fromId: string, toId: string): Promise<void> {
    this._assertUnlocked();
    if (this._findKey(toId) !== undefined) {
      throw new Error(`KeyStore: target id already exists "${toId}"`);
    }
    const stored = this._findKey(fromId);
    if (!stored) throw new Error(`KeyStore: key not found for id="${fromId}"`);
    stored.id = toId;
    await this._flush();
  }

  /**
   * Update the label on an existing key (without changing the raw key).
   * Used to migrate legacy accounts to the new label format.
   */
  async rotateLabel(id: string, newLabel: string): Promise<void> {
    this._assertUnlocked();
    const stored = this._findKey(id);
    if (!stored) throw new Error(`KeyStore: key not found for id="${id}"`);
    stored.label = newLabel;
    await this._flush();
  }

  /**
   * Check if a key exists for a given id.
   */
  hasKey(id: string): boolean {
    this._assertUnlocked();
    this._reloadStore();
    return this._findKey(id) !== undefined;
  }

  // ── UserOp signature helpers ────────────────────────────────────────────

  /**
   * Build the real-time mode signature bytes for a UserOperation.
   *
   * Format: [0x03][rawExecuteKey (32 bytes)] = 33 bytes total
   * EIP-7702 / validateFor7702: realtime ExecuteKey prefix (rejects 0x01 on this path).
   */
  buildRealtimeSig(instanceId: string): `0x${string}` {
    this._assertUnlocked();
    const rawKey = this.getKey(instanceId);
    if (!rawKey) throw new Error(`KeyStore: no execute key for instanceId="${instanceId}"`);

    const keyBytes = toBytes(rawKey);              // 32 bytes
    const sig      = new Uint8Array(33);
    sig[0]         = 0x03;                         // realtime ExecuteKey (7702 validator path)
    sig.set(keyBytes, 1);
    return toHex(sig) as `0x${string}`;
  }

  /**
   * Build the session mode signature bytes for a UserOperation.
   *
   * Format: [0x02][sessionId (32 bytes)][rawSessionKey (32 bytes)] = 65 bytes
   * Matches EchoPolicyValidator MODE_SESSION = 0x02
   */
  buildSessionSig(sessionId: string): `0x${string}` {
    this._assertUnlocked();
    const rawKey = this.getKey(sessionId);
    if (!rawKey) throw new Error(`KeyStore: no session key for sessionId="${sessionId}"`);

    const sidBytes = toBytes(sessionId as `0x${string}`);   // 32 bytes
    const keyBytes = toBytes(rawKey);                        // 32 bytes
    const sig      = new Uint8Array(65);
    sig[0]         = 0x02;                                   // MODE_SESSION
    sig.set(sidBytes, 1);
    sig.set(keyBytes, 33);
    return toHex(sig) as `0x${string}`;
  }

  // ── Private helpers ────────────────────────────────────────────────────

  private async _initialise(passphrase: string): Promise<void> {
    const salt   = randomBytes(SALT_LEN);
    this.encKey  = pbkdf2Sync(passphrase, salt, KDF_ITERATIONS, KDF_KEY_LEN, KDF_ALGO);
    this.store   = {
      version: KEYSTORE_VERSION,
      kdfSalt: salt.toString('base64'),
      keys:    [],
    };
    await this._flush();
  }

  private _encryptKey(rawKey: RawKey): { encryptedKey: string; iv: string; authTag: string } {
    const iv     = randomBytes(IV_LEN);
    const cipher = createCipheriv(AES_ALGO, this.encKey!, iv);
    const enc    = Buffer.concat([cipher.update(rawKey, 'utf8'), cipher.final()]);
    const tag    = cipher.getAuthTag();

    return {
      encryptedKey: enc.toString('base64'),
      iv:           iv.toString('base64'),
      authTag:      tag.toString('base64'),
    };
  }

  private _decryptKey(stored: StoredKey): RawKey {
    const iv       = Buffer.from(stored.iv, 'base64');
    const tag      = Buffer.from(stored.authTag, 'base64');
    const enc      = Buffer.from(stored.encryptedKey, 'base64');
    const decipher = createDecipheriv(AES_ALGO, this.encKey!, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
    return dec.toString('utf8') as RawKey;
  }

  /**
   * Re-read the store JSON from disk into memory without re-deriving encKey.
   * Called before every read so that keys added by another process (e.g. the
   * HTTP server writing new keys while the MCP stdio subprocess is running)
   * are immediately visible.  Silently ignored if the file no longer exists.
   */
  private _reloadStore(): void {
    if (!existsSync(this.path)) return;
    try {
      this.store = JSON.parse(readFileSync(this.path, 'utf8')) as KeyStoreFile;
    } catch { /* leave existing in-memory store intact on parse error */ }
  }

  private _findKey(id: string): StoredKey | undefined {
    return this.store!.keys.find(k => k.id === id);
  }

  private _assertUnlocked(): void {
    if (!this.isUnlocked) {
      throw new Error('KeyStore: not unlocked — call unlock(passphrase) first');
    }
  }

  private async _flush(): Promise<void> {
    // Simple mutex: wait until previous write completes
    while (this.writeLock) {
      await new Promise(r => setTimeout(r, 5));
    }
    this.writeLock = true;
    try {
      const dir = dirname(this.path);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const json = JSON.stringify(this.store, null, 2);
      // Atomic-ish write: write to tmp then rename (best-effort on all OSes)
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, json, { encoding: 'utf8', mode: 0o600 });
      // On POSIX rename is atomic. On Windows it may not be, acceptable for MVP.
      const { renameSync } = await import('node:fs');
      renameSync(tmp, this.path);
    } finally {
      this.writeLock = false;
    }
  }
}