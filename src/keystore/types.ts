/**
 * KeyStore types for Echo Protocol Gateway.
 *
 * Two key types:
 *
 * ExecuteKey — authorises real-time mode UserOperations.
 *   Scope: one PolicyInstance. Used for immediate user-commanded swaps.
 *   Storage: encrypted on disk, decrypted into memory on demand.
 *   On-chain: only keccak256(rawKey) is stored. Raw key never touches the chain.
 *
 * SessionKey — authorises session mode UserOperations.
 *   Scope: one SessionPolicy. Used for autonomous/scheduled tasks.
 *   Storage: encrypted on disk. Loaded by the scheduler when executing.
 *   On-chain: only keccak256(rawKey) is stored.
 */

/** Raw 32-byte key as a 0x-prefixed hex string. */
export type RawKey = `0x${string}`;

/** keccak256 of rawKey as a 0x-prefixed hex string. Stored on-chain. */
export type KeyHash = `0x${string}`;

export type KeyType = 'execute' | 'session';

export interface StoredKey {
  /** Unique identifier — instanceId for execute keys, sessionId for session keys */
  id: string;
  type: KeyType;
  /** Label for UI display (e.g. "OpenClaw agent", "DCA session") */
  label: string;
  /** AES-256-GCM encrypted raw key, base64-encoded */
  encryptedKey: string;
  /** AES-256-GCM IV, base64-encoded (12 bytes) */
  iv: string;
  /** AES-256-GCM auth tag, base64-encoded (16 bytes) */
  authTag: string;
  /** keccak256(rawKey) — stored in clear for fast lookup, safe to expose */
  keyHash: KeyHash;
  /** Unix timestamp (ms) when this key was created */
  createdAt: number;
  /** Optional: unix timestamp (ms) when this key expires */
  expiresAt?: number;
  /** Optional: arbitrary metadata (e.g. pendingTx calldata for session keys) */
  meta?: Record<string, string>;
}

export interface KeyStoreFile {
  version: 1;
  /** Argon2id-derived encryption key — we use PBKDF2 for Node.js built-in compat */
  kdfSalt: string;   // base64-encoded 32 bytes
  keys: StoredKey[];
}
