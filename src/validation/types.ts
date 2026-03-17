/**
 * PreValidator types for Echo Gateway.
 *
 * PreValidator mirrors EchoPolicyValidator's logic at the Gateway layer,
 * running before UserOps are submitted to the bundler. This provides:
 *   - Fast failure with human-readable error messages for the agent
 *   - Gas savings (no wasted bundler calls)
 *   - Two independent checkpoints (intent layer + transaction layer)
 *
 * It does NOT replace the on-chain validator — the chain is always the
 * final authority. PreValidator is a best-effort pre-flight check.
 */

import type { Address, Hex } from 'viem';
import type { SwapCalldata, SwapIntent } from '../tools/types.js';

// ── Validation result ──────────────────────────────────────────────────────

export type ValidationResult =
  | { ok: true }
  | { ok: false; reason: string; code: ValidationErrorCode };

export type ValidationErrorCode =
  // Instance-level
  | 'INSTANCE_NOT_FOUND'
  | 'INSTANCE_PAUSED'
  | 'INSTANCE_EXPIRED'
  // Token limits
  | 'TOKEN_NOT_PERMITTED'
  | 'EXCEEDS_PER_OP_LIMIT'
  | 'EXCEEDS_TOKEN_DAILY_LIMIT'
  | 'EXCEEDS_EXPLORATION_PER_TX'
  | 'EXPLORATION_BUDGET_EXHAUSTED'
  // Global limits
  | 'EXCEEDS_GLOBAL_DAILY_LIMIT'
  | 'GLOBAL_BUDGET_EXHAUSTED'
  // Calldata checks (pre-validation #2)
  | 'TARGET_NOT_ALLOWED'
  | 'SELECTOR_NOT_ALLOWED'
  | 'RECIPIENT_MISMATCH'
  | 'AMOUNT_MISMATCH'
  // Session-specific
  | 'SESSION_NOT_FOUND'
  | 'SESSION_REVOKED'
  | 'SESSION_EXPIRED'
  | 'SESSION_TOKEN_MISMATCH'
  | 'SESSION_EXCEEDS_PER_OP'
  | 'SESSION_BUDGET_EXHAUSTED'
  | 'SESSION_DAILY_OPS_EXCEEDED';

// ── Pre-validation #1 input ────────────────────────────────────────────────

/** Input for pre-validation stage 1 (intent layer, before Tool is called). */
export interface IntentValidationInput {
  instanceId: Hex;
  intent: SwapIntent;
  /** Mode determines which policy to check against */
  mode: 'realtime' | 'session';
  /** Required for session mode */
  sessionId?: Hex;
}

// ── Pre-validation #2 input ────────────────────────────────────────────────

/** Input for pre-validation stage 2 (transaction layer, after Tool returns calldata). */
export interface CalldataValidationInput {
  instanceId: Hex;
  /** The smart account address — recipient must equal this */
  accountAddress: Address;
  /** Calldata returned by UniswapV3Tool.quoteAndBuild() */
  swapCalldata: SwapCalldata;
  /** Original intent, used to cross-check amount */
  intent: SwapIntent;
}
