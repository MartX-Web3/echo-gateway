/**
 * PreValidator — two-stage pre-flight check for Echo Gateway.
 *
 * Stage 1 — Intent validation (before UniswapV3Tool is called):
 *   Reads PolicyInstance / SessionPolicy from chain and checks limits.
 *   Fails fast if the intent would definitely be rejected on-chain.
 *
 * Stage 2 — Calldata validation (after UniswapV3Tool returns calldata):
 *   Verifies target, selector, recipient, and amount against policy.
 *   This is a structural check — it does NOT re-run limit arithmetic
 *   (that was done in stage 1). Its purpose is to catch any discrepancy
 *   between the intent the agent declared and the calldata the tool built.
 *
 * Design notes:
 *   - All reads use getInstanceValidation / getSessionValidation (struct
 *     returns) from the deployed PolicyRegistry ABI.
 *   - Daily counters are reset in the same way as the on-chain contract:
 *     if lastOpDay != today, the counter is treated as 0.
 *   - Times are in seconds (block.timestamp compatible).
 *   - This is a read-only component — it never writes to the chain.
 */

import { createPublicClient, http, keccak256, encodePacked } from 'viem';
import { sepolia } from 'viem/chains';
import type { Address, Hex, PublicClient } from 'viem';
import { POLICY_REGISTRY_ABI } from '../contracts/PolicyRegistryABI.js';
import type {
  ValidationResult,
  IntentValidationInput,
  CalldataValidationInput,
} from './types.js';

const SECONDS_PER_DAY = 86_400n;

export interface PreValidatorConfig {
  rpcUrl:           string;
  policyRegistry:   Address;
}

export class PreValidator {
  private readonly client: PublicClient;
  private readonly registry: Address;

  constructor(config: PreValidatorConfig) {
    this.client = createPublicClient({
      chain:     sepolia,
      transport: http(config.rpcUrl),
    });
    this.registry = config.policyRegistry;
  }

  // ── Stage 1: Intent validation ─────────────────────────────────────────

  /**
   * Validate a swap intent against the on-chain PolicyInstance or SessionPolicy.
   * Called BEFORE UniswapV3Tool.quoteAndBuild().
   *
   * Checks (realtime mode):
   *   1. Instance exists and is not paused
   *   2. Instance is not expired
   *   3. tokenOut is permitted (tokenLimit or exploration budget)
   *   4. amount ≤ maxPerOp (or explorationPerTx)
   *   5. token daily cap not exceeded
   *   6. global daily cap not exceeded
   *   7. global total budget not exhausted
   *
   * Checks (session mode, additional):
   *   1. Session exists, is active, not expired
   *   2. tokenIn / tokenOut match session
   *   3. amount ≤ session.maxAmountPerOp
   *   4. session total budget not exhausted
   *   5. session daily ops not exceeded
   *   + all MetaPolicy global checks above
   */
  async validateIntent(input: IntentValidationInput): Promise<ValidationResult> {
    if (input.mode === 'session' && input.sessionId) {
      return this._validateSessionIntent(input);
    }
    return this._validateRealtimeIntent(input);
  }

  // ── Stage 2: Calldata validation ───────────────────────────────────────

  /**
   * Validate calldata returned by UniswapV3Tool against the policy.
   * Called AFTER UniswapV3Tool.quoteAndBuild().
   *
   * Checks:
   *   1. target in allowedTargets
   *   2. selector in allowedSelectors
   *   3. recipient == accountAddress (S2)
   *   4. tokenOut matches intent.tokenOut
   *   5. amountIn is consistent with intent direction and amount
   */
  async validateCalldata(input: CalldataValidationInput): Promise<ValidationResult> {
    const { instanceId, accountAddress, swapCalldata, intent } = input;

    // Check 1 — target in allowedTargets
    const targetAllowed = await this.client.readContract({
      address:      this.registry,
      abi:          POLICY_REGISTRY_ABI,
      functionName: 'isAllowedTarget',
      args:         [instanceId, swapCalldata.target],
    });
    if (!targetAllowed) {
      return fail('TARGET_NOT_ALLOWED',
        `Target ${swapCalldata.target} is not in allowedTargets for instance ${instanceId}`);
    }

    // Check 2 — selector in allowedSelectors
    const selectorAllowed = await this.client.readContract({
      address:      this.registry,
      abi:          POLICY_REGISTRY_ABI,
      functionName: 'isAllowedSelector',
      args:         [instanceId, swapCalldata.selector as Hex],
    });
    if (!selectorAllowed) {
      return fail('SELECTOR_NOT_ALLOWED',
        `Selector ${swapCalldata.selector} is not in allowedSelectors for instance ${instanceId}`);
    }

    // Check 3 — recipient == accountAddress (S2)
    if (swapCalldata.recipient.toLowerCase() !== accountAddress.toLowerCase()) {
      return fail('RECIPIENT_MISMATCH',
        `Calldata recipient ${swapCalldata.recipient} does not match account ${accountAddress}. ` +
        `This should never happen — report this as a Gateway bug.`);
    }

    // Check 4 — tokenOut matches intent
    if (swapCalldata.quote.tokenOut.toLowerCase() !== intent.tokenOut.toLowerCase()) {
      return fail('AMOUNT_MISMATCH',
        `Calldata tokenOut ${swapCalldata.quote.tokenOut} does not match intent.tokenOut ${intent.tokenOut}`);
    }

    // Check 5 — amount consistency
    if (intent.direction === 'exactInput') {
      if (swapCalldata.quote.amountIn !== intent.amount) {
        return fail('AMOUNT_MISMATCH',
          `Calldata amountIn ${swapCalldata.quote.amountIn} does not match intent.amount ${intent.amount}`);
      }
    } else {
      if (swapCalldata.quote.amountOut !== intent.amount) {
        return fail('AMOUNT_MISMATCH',
          `Calldata amountOut ${swapCalldata.quote.amountOut} does not match intent.amount ${intent.amount}`);
      }
    }

    return { ok: true };
  }

  // ── Private: realtime validation ───────────────────────────────────────

  private async _validateRealtimeIntent(input: IntentValidationInput): Promise<ValidationResult> {
    const { instanceId, intent } = input;

    // Read instance validation struct
    const inst = await this.client.readContract({
      address:      this.registry,
      abi:          POLICY_REGISTRY_ABI,
      functionName: 'getInstanceValidation',
      args:         [instanceId],
    });

    // Check 1 — not paused
    if (inst.paused) {
      return fail('INSTANCE_PAUSED', `Instance ${instanceId} is paused`);
    }

    // Check 2 — not expired
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (now >= BigInt(inst.expiry)) {
      return fail('INSTANCE_EXPIRED',
        `Instance ${instanceId} expired at ${inst.expiry}`);
    }

    // Check 3–5: token limits or exploration
    const tlResult = await this._checkTokenLimits(instanceId, intent, inst);
    if (!tlResult.ok) return tlResult;

    // Check 6 — global daily cap
    const today = now / SECONDS_PER_DAY;
    const effectiveGlobalDaily = inst.lastOpDay === today ? inst.globalDailySpent : 0n;
    if (effectiveGlobalDaily + intent.amount > inst.globalMaxPerDay) {
      return fail('EXCEEDS_GLOBAL_DAILY_LIMIT',
        `Global daily limit would be exceeded: ` +
        `spent=${effectiveGlobalDaily}, amount=${intent.amount}, limit=${inst.globalMaxPerDay}`);
    }

    // Check 7 — global total budget
    if (inst.globalTotalSpent + intent.amount > inst.globalTotalBudget) {
      return fail('GLOBAL_BUDGET_EXHAUSTED',
        `Global total budget exhausted: ` +
        `spent=${inst.globalTotalSpent}, amount=${intent.amount}, budget=${inst.globalTotalBudget}`);
    }

    return { ok: true };
  }

  // ── Private: session validation ────────────────────────────────────────

  private async _validateSessionIntent(input: IntentValidationInput): Promise<ValidationResult> {
    const { instanceId, intent, sessionId } = input;

    // Read session validation struct
    const sess = await this.client.readContract({
      address:      this.registry,
      abi:          POLICY_REGISTRY_ABI,
      functionName: 'getSessionValidation',
      args:         [sessionId!],
    });

    // Check 1 — session active
    if (!sess.active) {
      return fail('SESSION_REVOKED', `Session ${sessionId} has been revoked`);
    }

    // Check 2 — session not expired
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (now >= BigInt(sess.sessionExpiry)) {
      return fail('SESSION_EXPIRED',
        `Session ${sessionId} expired at ${sess.sessionExpiry}`);
    }

    // Check 3 — session belongs to instance
    if (sess.instanceId.toLowerCase() !== instanceId.toLowerCase()) {
      return fail('SESSION_NOT_FOUND',
        `Session ${sessionId} belongs to instance ${sess.instanceId}, not ${instanceId}`);
    }

    // Check 4 — tokenIn matches
    if (sess.tokenIn.toLowerCase() !== intent.tokenIn.toLowerCase()) {
      return fail('SESSION_TOKEN_MISMATCH',
        `Intent tokenIn ${intent.tokenIn} does not match session tokenIn ${sess.tokenIn}`);
    }

    // Check 5 — tokenOut matches
    if (sess.tokenOut.toLowerCase() !== intent.tokenOut.toLowerCase()) {
      return fail('SESSION_TOKEN_MISMATCH',
        `Intent tokenOut ${intent.tokenOut} does not match session tokenOut ${sess.tokenOut}`);
    }

    // Check 6 — amount ≤ session maxAmountPerOp
    if (intent.amount > sess.maxAmountPerOp) {
      return fail('SESSION_EXCEEDS_PER_OP',
        `Amount ${intent.amount} exceeds session maxAmountPerOp ${sess.maxAmountPerOp}`);
    }

    // Check 7 — session total budget
    if (sess.totalSpent + intent.amount > sess.totalBudget) {
      return fail('SESSION_BUDGET_EXHAUSTED',
        `Session budget exhausted: spent=${sess.totalSpent}, amount=${intent.amount}, budget=${sess.totalBudget}`);
    }

    // Check 8 — session daily ops
    const today = now / SECONDS_PER_DAY;
    const effectiveDailyOps = sess.lastOpDay === today ? sess.dailyOps : 0n;
    if (effectiveDailyOps + 1n > sess.maxOpsPerDay) {
      return fail('SESSION_DAILY_OPS_EXCEEDED',
        `Session daily ops limit reached: ops=${effectiveDailyOps}, limit=${sess.maxOpsPerDay}`);
    }

    // Check MetaPolicy global caps (subset re-verification)
    const inst = await this.client.readContract({
      address:      this.registry,
      abi:          POLICY_REGISTRY_ABI,
      functionName: 'getInstanceValidation',
      args:         [instanceId],
    });

    if (inst.paused) {
      return fail('INSTANCE_PAUSED', `Instance ${instanceId} is paused`);
    }
    if (now >= BigInt(inst.expiry)) {
      return fail('INSTANCE_EXPIRED', `Instance ${instanceId} expired`);
    }

    const effectiveGlobalDaily = inst.lastOpDay === today ? inst.globalDailySpent : 0n;
    if (effectiveGlobalDaily + intent.amount > inst.globalMaxPerDay) {
      return fail('EXCEEDS_GLOBAL_DAILY_LIMIT',
        `Global daily limit would be exceeded`);
    }
    if (inst.globalTotalSpent + intent.amount > inst.globalTotalBudget) {
      return fail('GLOBAL_BUDGET_EXHAUSTED', `Global total budget exhausted`);
    }

    // Subset re-verification: token-level constraints
    const tlResult = await this._checkTokenLimits(instanceId, intent, inst);
    if (!tlResult.ok) return tlResult;

    return { ok: true };
  }

  // ── Private: token limit checks ────────────────────────────────────────

  private async _checkTokenLimits(
    instanceId: Hex,
    intent: IntentValidationInput['intent'],
    inst: { explorationBudget: bigint; explorationPerTx: bigint; explorationSpent: bigint; lastOpDay: bigint },
  ): Promise<ValidationResult> {
    const now   = BigInt(Math.floor(Date.now() / 1000));
    const today = now / SECONDS_PER_DAY;

    const tl = await this.client.readContract({
      address:      this.registry,
      abi:          POLICY_REGISTRY_ABI,
      functionName: 'getTokenLimitValidation',
      args:         [instanceId, intent.tokenOut],
    });

    const isExploration = tl.maxPerOp === 0n;

    if (isExploration) {
      // Exploration token checks
      if (inst.explorationBudget === 0n) {
        return fail('TOKEN_NOT_PERMITTED',
          `Token ${intent.tokenOut} is not in tokenLimits and exploration budget is 0`);
      }
      if (intent.amount > inst.explorationPerTx) {
        return fail('EXCEEDS_EXPLORATION_PER_TX',
          `Amount ${intent.amount} exceeds explorationPerTx ${inst.explorationPerTx}`);
      }
      if (inst.explorationSpent + intent.amount > inst.explorationBudget) {
        return fail('EXPLORATION_BUDGET_EXHAUSTED',
          `Exploration budget exhausted: spent=${inst.explorationSpent}, ` +
          `amount=${intent.amount}, budget=${inst.explorationBudget}`);
      }
    } else {
      // Whitelisted token checks
      if (intent.amount > tl.maxPerOp) {
        return fail('EXCEEDS_PER_OP_LIMIT',
          `Amount ${intent.amount} exceeds maxPerOp ${tl.maxPerOp} for token ${intent.tokenOut}`);
      }
      const effectiveTokenDaily = tl.lastOpDay === today ? tl.dailySpent : 0n;
      if (effectiveTokenDaily + intent.amount > tl.maxPerDay) {
        return fail('EXCEEDS_TOKEN_DAILY_LIMIT',
          `Token daily limit would be exceeded for ${intent.tokenOut}: ` +
          `spent=${effectiveTokenDaily}, amount=${intent.amount}, limit=${tl.maxPerDay}`);
      }
    }

    return { ok: true };
  }
}

// ── Helper ─────────────────────────────────────────────────────────────────

function fail(
  code: import('./types.js').ValidationErrorCode,
  reason: string,
): ValidationResult {
  return { ok: false, code, reason };
}
