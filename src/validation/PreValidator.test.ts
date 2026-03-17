/**
 * PreValidator unit tests.
 * All chain reads are mocked — no real RPC calls.
 *
 * Covers:
 *   Stage 1 realtime:  paused, expired, token limits, exploration, global caps
 *   Stage 1 session:   revoked, expired, token mismatch, per-op, budget, daily ops,
 *                      MetaPolicy global caps (subset re-verification)
 *   Stage 2 calldata:  target, selector, recipient (S2), tokenOut, amount
 *   Daily reset logic: lastOpDay != today → counter treated as 0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PreValidator } from './PreValidator.js';
import type { IntentValidationInput, CalldataValidationInput } from './types.js';
import type { SwapCalldata } from '../tools/types.js';

// ── Mock viem ──────────────────────────────────────────────────────────────

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    createPublicClient: vi.fn(),
  };
});

import { createPublicClient } from 'viem';

// Returns a fresh readContract mock for each call to createPublicClient.
// This prevents mock state from leaking between tests.
function setupMock(): ReturnType<typeof vi.fn> {
  const readContract = vi.fn();
  (createPublicClient as ReturnType<typeof vi.fn>).mockReturnValueOnce({ readContract });
  return readContract;
}

// ── Constants ──────────────────────────────────────────────────────────────

const REGISTRY   = '0x5A9C627774f4f02977CE9Fd7e4FEDe5AC281e938' as const;
const INSTANCE   = ('0x' + 'ab'.repeat(32)) as `0x${string}`;
const SESSION    = ('0x' + 'cd'.repeat(32)) as `0x${string}`;
const USDC       = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as const;
const WETH       = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as const;
const ROUTER     = '0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E' as const;
const ACCOUNT    = '0x1234567890123456789012345678901234567890' as const;
const ATTACKER   = '0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead' as const;

const NOW_SEC    = BigInt(Math.floor(Date.now() / 1000));
const TODAY      = NOW_SEC / 86_400n;
const FUTURE     = NOW_SEC + 86_400n * 90n; // 90 days from now

// ── Fixtures ───────────────────────────────────────────────────────────────

function makeInst(overrides: Record<string, unknown> = {}) {
  return {
    explorationBudget: 50n * 10n ** 6n,
    explorationPerTx:  10n * 10n ** 6n,
    explorationSpent:  0n,
    globalMaxPerDay:   1000n * 10n ** 6n,
    globalTotalBudget: 5000n * 10n ** 6n,
    globalTotalSpent:  0n,
    globalDailySpent:  0n,
    lastOpDay:         TODAY,
    lastOpTimestamp:   NOW_SEC - 10n,
    expiry:            FUTURE,
    paused:            false,
    ...overrides,
  };
}

function makeTl(overrides: Record<string, unknown> = {}) {
  return {
    maxPerOp:   100n * 10n ** 6n,
    maxPerDay:  500n * 10n ** 6n,
    dailySpent: 0n,
    lastOpDay:  TODAY,
    ...overrides,
  };
}

function makeSess(overrides: Record<string, unknown> = {}) {
  return {
    instanceId:    INSTANCE,
    sessionKeyHash: '0x' + 'ee'.repeat(32),
    tokenIn:       USDC,
    tokenOut:      WETH,
    maxAmountPerOp: 50n * 10n ** 6n,
    totalBudget:   350n * 10n ** 6n,
    totalSpent:    0n,
    maxOpsPerDay:  2n,
    dailyOps:      0n,
    lastOpDay:     TODAY,
    sessionExpiry: FUTURE,
    active:        true,
    ...overrides,
  };
}

function makeValidator() {
  return new PreValidator({ rpcUrl: 'https://rpc.example.com', policyRegistry: REGISTRY });
}

function makeRealtimeInput(amountOverride?: bigint): IntentValidationInput {
  return {
    instanceId: INSTANCE,
    intent: {
      tokenIn:   USDC,
      tokenOut:  WETH,
      amount:    amountOverride ?? 50n * 10n ** 6n,
      direction: 'exactInput',
      feeTier:   3000,
    },
    mode: 'realtime',
  };
}

function makeSessionInput(amountOverride?: bigint): IntentValidationInput {
  return {
    instanceId: INSTANCE,
    sessionId:  SESSION,
    intent: {
      tokenIn:   USDC,
      tokenOut:  WETH,
      amount:    amountOverride ?? 50n * 10n ** 6n,
      direction: 'exactInput',
      feeTier:   3000,
    },
    mode: 'session',
  };
}

function makeCalldataInput(overrides: Partial<SwapCalldata> = {}): CalldataValidationInput {
  return {
    instanceId:    INSTANCE,
    accountAddress: ACCOUNT,
    swapCalldata: {
      calldata:  '0xdeadbeef' as `0x${string}`,
      target:    ROUTER,
      selector:  '0x414bf389' as `0x${string}`,
      recipient: ACCOUNT,
      quote: {
        tokenIn:            USDC,
        tokenOut:           WETH,
        amountIn:           50n * 10n ** 6n,
        amountOut:          20n * 10n ** 18n,
        feeTier:            3000,
        amountWithSlippage: 19n * 10n ** 18n,
        priceImpactBps:     30,
        sqrtPriceLimitX96:  0n,
      },
      ...overrides,
    },
    intent: {
      tokenIn: USDC, tokenOut: WETH,
      amount: 50n * 10n ** 6n, direction: 'exactInput', feeTier: 3000,
    },
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('PreValidator', () => {
  beforeEach(() => vi.clearAllMocks());

  // ── Stage 1: realtime ────────────────────────────────────────────────────

  describe('validateIntent — realtime', () => {

    it('passes when all checks pass', async () => {
      const readContract = setupMock();
      const v = makeValidator();
      readContract
        .mockResolvedValueOnce(makeInst())
        .mockResolvedValueOnce(makeTl());

      const r = await v.validateIntent(makeRealtimeInput());
      expect(r.ok).toBe(true);
    });

    it('fails when instance is paused', async () => {
      const readContract = setupMock();
      const v = makeValidator();
      readContract.mockResolvedValueOnce(makeInst({ paused: true }));

      const r = await v.validateIntent(makeRealtimeInput());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('INSTANCE_PAUSED');
    });

    it('fails when instance is expired', async () => {
      const readContract = setupMock();
      const v = makeValidator();
      readContract.mockResolvedValueOnce(makeInst({ expiry: NOW_SEC - 1n }));

      const r = await v.validateIntent(makeRealtimeInput());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('INSTANCE_EXPIRED');
    });

    it('fails when token not permitted (maxPerOp=0, explorationBudget=0)', async () => {
      const readContract = setupMock();
      const v = makeValidator();
      readContract
        .mockResolvedValueOnce(makeInst({ explorationBudget: 0n }))
        .mockResolvedValueOnce(makeTl({ maxPerOp: 0n, maxPerDay: 0n }));

      const r = await v.validateIntent(makeRealtimeInput());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('TOKEN_NOT_PERMITTED');
    });

    it('fails when amount exceeds per-op limit', async () => {
      const readContract = setupMock();
      const v = makeValidator();
      readContract
        .mockResolvedValueOnce(makeInst())
        .mockResolvedValueOnce(makeTl({ maxPerOp: 10n * 10n ** 6n })); // limit 10, amount 50

      const r = await v.validateIntent(makeRealtimeInput());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('EXCEEDS_PER_OP_LIMIT');
    });

    it('fails when token daily limit exceeded', async () => {
      const readContract = setupMock();
      const v = makeValidator();
      readContract
        .mockResolvedValueOnce(makeInst())
        .mockResolvedValueOnce(makeTl({
          maxPerDay:  60n * 10n ** 6n,
          dailySpent: 20n * 10n ** 6n, // 20 + 50 = 70 > 60
          lastOpDay:  TODAY,
        }));

      const r = await v.validateIntent(makeRealtimeInput());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('EXCEEDS_TOKEN_DAILY_LIMIT');
    });

    it('daily spent resets when lastOpDay != today', async () => {
      const readContract = setupMock();
      const v = makeValidator();
      readContract
        .mockResolvedValueOnce(makeInst())
        .mockResolvedValueOnce(makeTl({
          maxPerDay:  60n * 10n ** 6n,
          dailySpent: 55n * 10n ** 6n, // would fail if today — but lastOpDay is yesterday
          lastOpDay:  TODAY - 1n,       // yesterday → reset to 0
        }));

      const r = await v.validateIntent(makeRealtimeInput());
      expect(r.ok).toBe(true);
    });

    it('fails on exploration per-tx exceeded', async () => {
      const readContract = setupMock();
      const v = makeValidator();
      readContract
        .mockResolvedValueOnce(makeInst({ explorationPerTx: 5n * 10n ** 6n }))
        .mockResolvedValueOnce(makeTl({ maxPerOp: 0n })); // exploration token

      const r = await v.validateIntent(makeRealtimeInput()); // amount = 50 > 5
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('EXCEEDS_EXPLORATION_PER_TX');
    });

    it('fails when exploration budget exhausted', async () => {
      const readContract = setupMock();
      const v = makeValidator();
      readContract
        .mockResolvedValueOnce(makeInst({
          explorationBudget: 50n * 10n ** 6n,
          explorationPerTx:  100n * 10n ** 6n, // per-tx high enough not to trigger first
          explorationSpent:  45n * 10n ** 6n,  // 45 + 50 > 50 → budget exhausted
        }))
        .mockResolvedValueOnce(makeTl({ maxPerOp: 0n }));

      const r = await v.validateIntent(makeRealtimeInput());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('EXPLORATION_BUDGET_EXHAUSTED');
    });

    it('fails when global daily cap exceeded', async () => {
      const readContract = setupMock();
      const v = makeValidator();
      readContract
        .mockResolvedValueOnce(makeInst({
          globalMaxPerDay:  60n * 10n ** 6n,
          globalDailySpent: 20n * 10n ** 6n, // 20 + 50 = 70 > 60
          lastOpDay:        TODAY,
        }))
        .mockResolvedValueOnce(makeTl());

      const r = await v.validateIntent(makeRealtimeInput());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('EXCEEDS_GLOBAL_DAILY_LIMIT');
    });

    it('fails when global total budget exhausted', async () => {
      const readContract = setupMock();
      const v = makeValidator();
      readContract
        .mockResolvedValueOnce(makeInst({
          globalTotalBudget: 5000n * 10n ** 6n,
          globalTotalSpent:  4980n * 10n ** 6n, // 4980 + 50 > 5000
        }))
        .mockResolvedValueOnce(makeTl());

      const r = await v.validateIntent(makeRealtimeInput());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('GLOBAL_BUDGET_EXHAUSTED');
    });
  });

  // ── Stage 1: session ─────────────────────────────────────────────────────

  describe('validateIntent — session', () => {

    it('passes when all session checks pass', async () => {
      const readContract = setupMock();
      const v = makeValidator();
      readContract
        .mockResolvedValueOnce(makeSess())    // getSessionValidation
        .mockResolvedValueOnce(makeInst())    // getInstanceValidation
        .mockResolvedValueOnce(makeTl());     // getTokenLimitValidation

      const r = await v.validateIntent(makeSessionInput());
      expect(r.ok).toBe(true);
    });

    it('fails when session is revoked', async () => {
      const readContract = setupMock();
      const v = makeValidator();
      readContract.mockResolvedValueOnce(makeSess({ active: false }));

      const r = await v.validateIntent(makeSessionInput());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('SESSION_REVOKED');
    });

    it('fails when session is expired', async () => {
      const readContract = setupMock();
      const v = makeValidator();
      readContract.mockResolvedValueOnce(makeSess({ sessionExpiry: NOW_SEC - 1n }));

      const r = await v.validateIntent(makeSessionInput());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('SESSION_EXPIRED');
    });

    it('fails when tokenOut does not match session', async () => {
      const readContract = setupMock();
      const v = makeValidator();
      readContract.mockResolvedValueOnce(makeSess({ tokenOut: USDC })); // session expects USDC out, intent says WETH

      const r = await v.validateIntent(makeSessionInput());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('SESSION_TOKEN_MISMATCH');
    });

    it('fails when amount exceeds session maxAmountPerOp', async () => {
      const readContract = setupMock();
      const v = makeValidator();
      readContract.mockResolvedValueOnce(makeSess({ maxAmountPerOp: 10n * 10n ** 6n }));

      const r = await v.validateIntent(makeSessionInput()); // amount = 50 > 10
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('SESSION_EXCEEDS_PER_OP');
    });

    it('fails when session total budget exhausted', async () => {
      const readContract = setupMock();
      const v = makeValidator();
      readContract.mockResolvedValueOnce(makeSess({
        totalBudget: 350n * 10n ** 6n,
        totalSpent:  320n * 10n ** 6n, // 320 + 50 > 350
      }));

      const r = await v.validateIntent(makeSessionInput());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('SESSION_BUDGET_EXHAUSTED');
    });

    it('fails when session daily ops exceeded', async () => {
      const readContract = setupMock();
      const v = makeValidator();
      readContract.mockResolvedValueOnce(makeSess({
        maxOpsPerDay: 2n,
        dailyOps:     2n,  // already at limit
        lastOpDay:    TODAY,
      }));

      const r = await v.validateIntent(makeSessionInput());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('SESSION_DAILY_OPS_EXCEEDED');
    });

    it('session daily ops resets when lastOpDay != today', async () => {
      const readContract = setupMock();
      const v = makeValidator();
      readContract
        .mockResolvedValueOnce(makeSess({
          maxOpsPerDay: 2n,
          dailyOps:     2n,        // would fail today — but last op was yesterday
          lastOpDay:    TODAY - 1n,
        }))
        .mockResolvedValueOnce(makeInst())
        .mockResolvedValueOnce(makeTl());

      const r = await v.validateIntent(makeSessionInput());
      expect(r.ok).toBe(true);
    });

    it('fails on MetaPolicy global daily cap (subset re-verify)', async () => {
      const readContract = setupMock();
      const v = makeValidator();
      readContract
        .mockResolvedValueOnce(makeSess())
        .mockResolvedValueOnce(makeInst({
          globalMaxPerDay:  60n * 10n ** 6n,
          globalDailySpent: 20n * 10n ** 6n,
          lastOpDay:        TODAY,
        }))
        .mockResolvedValueOnce(makeTl());

      const r = await v.validateIntent(makeSessionInput());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('EXCEEDS_GLOBAL_DAILY_LIMIT');
    });

    it('fails on MetaPolicy paused (subset re-verify)', async () => {
      const readContract = setupMock();
      const v = makeValidator();
      readContract
        .mockResolvedValueOnce(makeSess({ active: true })) // session passes all checks
        .mockResolvedValueOnce(makeInst({ paused: true })) // but MetaPolicy is paused
        // no token limit call needed — paused check comes before it
      const r = await v.validateIntent(makeSessionInput());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('INSTANCE_PAUSED');
    });
  });

  // ── Stage 2: calldata ─────────────────────────────────────────────────────

  describe('validateCalldata', () => {

    it('passes when all checks pass', async () => {
      const readContract = setupMock();
      const v = makeValidator();
      readContract
        .mockResolvedValueOnce(true)   // isAllowedTarget
        .mockResolvedValueOnce(true);  // isAllowedSelector

      const r = await v.validateCalldata(makeCalldataInput());
      expect(r.ok).toBe(true);
    });

    it('fails when target not in allowedTargets', async () => {
      const readContract = setupMock();
      const v = makeValidator();
      // isAllowedTarget returns false
      readContract.mockResolvedValueOnce(false);

      const r = await v.validateCalldata(makeCalldataInput());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('TARGET_NOT_ALLOWED');
    });

    it('fails when selector not in allowedSelectors', async () => {
      const readContract = setupMock();
      const v = makeValidator();
      // First call (isAllowedTarget) = true, second call (isAllowedSelector) = false
      readContract
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);

      const r = await v.validateCalldata(makeCalldataInput());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('SELECTOR_NOT_ALLOWED');
    });

    it('S2: fails when recipient is not the account address', async () => {
      const readContract = setupMock();
      const v = makeValidator();
      // Both target and selector pass, then recipient check fails in code
      readContract
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true);

      const r = await v.validateCalldata(makeCalldataInput({ recipient: ATTACKER }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('RECIPIENT_MISMATCH');
    });

    it('S2: passes when recipient exactly equals account address', async () => {
      const readContract = setupMock();
      const v = makeValidator();
      readContract
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true);

      const r = await v.validateCalldata(makeCalldataInput({ recipient: ACCOUNT }));
      expect(r.ok).toBe(true);
    });

    it('S2: address comparison is case-insensitive', async () => {
      const readContract = setupMock();
      const v = makeValidator();
      readContract
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true);

      // Account in calldata is uppercased — should still match
      const r = await v.validateCalldata(makeCalldataInput({
        recipient: ACCOUNT.toUpperCase() as `0x${string}`,
      }));
      expect(r.ok).toBe(true);
    });

    it('fails when tokenOut in calldata does not match intent', async () => {
      const readContract = setupMock();
      const v = makeValidator();
      readContract
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true);

      const input = makeCalldataInput();
      input.swapCalldata.quote.tokenOut = USDC; // should be WETH

      const r = await v.validateCalldata(input);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('AMOUNT_MISMATCH');
    });

    it('fails when amountIn in calldata does not match exactInput intent', async () => {
      const readContract = setupMock();
      const v = makeValidator();
      readContract
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true);

      const input = makeCalldataInput();
      input.swapCalldata.quote.amountIn = 999n * 10n ** 6n; // ≠ intent.amount

      const r = await v.validateCalldata(input);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('AMOUNT_MISMATCH');
    });

    it('exactOutput: fails when amountOut in calldata does not match intent', async () => {
      const readContract = setupMock();
      const v = makeValidator();
      readContract
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true);

      const input = makeCalldataInput();
      input.intent = { ...input.intent, direction: 'exactOutput', amount: 1n * 10n ** 18n };
      input.swapCalldata.quote.amountOut = 999n * 10n ** 18n; // ≠ intent.amount

      const r = await v.validateCalldata(input);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('AMOUNT_MISMATCH');
    });
  });
});