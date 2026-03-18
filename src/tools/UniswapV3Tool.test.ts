/**
 * UniswapV3Tool unit tests.
 *
 * The Quoter is mocked — no real RPC calls.
 * Tests verify:
 *   - quote() builds correct SwapQuote for exactInput and exactOutput
 *   - slippage is applied correctly (amountWithSlippage)
 *   - buildCalldata() produces correct ABI-encoded calldata
 *   - selector matches IntentRegistry constants
 *   - recipient is ALWAYS the provided AccountERC7579 (S2)
 *   - fee tier auto-detection falls through to next tier on failure
 *   - zero-quote throws (no liquidity)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { decodeFunctionData } from 'viem';
import { UniswapV3Tool } from './UniswapV3Tool.js';
import { SWAP_ROUTER_ABI, SELECTORS } from './abis.js';
import type { SwapIntent } from './types.js';

// ── Addresses ──────────────────────────────────────────────────────────────

const SWAP_ROUTER   = '0xC272Ce98e3a103297EB3A57E4f86902c0fdd2081' as const;
const QUOTER_V2     = '0x2e49DaB78491F0C82636401a59602661cdA51Bb5' as const;
const USDC          = '0x10A41D59249F0b143fe73d8583f112AF66375ea0' as const;
const WETH          = '0x78f1422Df8c4631fd3ACe3c2E1b02df6d815e541' as const;
const ACCOUNT       = '0x1234567890123456789012345678901234567890' as const;

// ── Mock setup ─────────────────────────────────────────────────────────────

// Mock viem's createPublicClient so no real network calls are made
vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    createPublicClient: vi.fn().mockReturnValue({
      simulateContract: vi.fn(),
    }),
  };
});

import { createPublicClient } from 'viem';

function getMockClient() {
  return (createPublicClient as ReturnType<typeof vi.fn>).mock.results[0]?.value as {
    simulateContract: ReturnType<typeof vi.fn>;
  };
}

// ── Test factory ───────────────────────────────────────────────────────────

function makeTool() {
  return new UniswapV3Tool({
    rpcUrl:      'https://rpc.example.com',
    swapRouter:  SWAP_ROUTER,
    quoterV2:    QUOTER_V2,
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('UniswapV3Tool', () => {

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── quote: exactInput ──────────────────────────────────────────────────

  describe('quote — exactInput', () => {
    it('returns correct quote fields', async () => {
      const tool = makeTool();
      getMockClient().simulateContract.mockResolvedValueOnce({
        result: [200n * 10n ** 18n, 0n, 0n, 0n], // amountOut = 200 WETH
      });

      const intent: SwapIntent = {
        tokenIn:   USDC,
        tokenOut:  WETH,
        amount:    100n * 10n ** 6n, // 100 USDC
        direction: 'exactInput',
        feeTier:   3000,
      };

      const q = await tool.quote(intent);

      expect(q.tokenIn).toBe(USDC);
      expect(q.tokenOut).toBe(WETH);
      expect(q.amountIn).toBe(100n * 10n ** 6n);
      expect(q.amountOut).toBe(200n * 10n ** 18n);
      expect(q.feeTier).toBe(3000);
      expect(q.sqrtPriceLimitX96).toBe(0n);
    });

    it('applies default slippage (50 bps) to amountWithSlippage', async () => {
      const tool = makeTool();
      getMockClient().simulateContract.mockResolvedValueOnce({
        result: [10_000n, 0n, 0n, 0n],
      });

      const q = await tool.quote({
        tokenIn: USDC, tokenOut: WETH,
        amount: 1000n, direction: 'exactInput', feeTier: 3000,
      });

      // amountOutMinimum = 10000 * (10000 - 50) / 10000 = 9950
      expect(q.amountWithSlippage).toBe(9950n);
    });

    it('applies custom slippage correctly', async () => {
      const tool = makeTool();
      getMockClient().simulateContract.mockResolvedValueOnce({
        result: [10_000n, 0n, 0n, 0n],
      });

      const q = await tool.quote({
        tokenIn: USDC, tokenOut: WETH,
        amount: 1000n, direction: 'exactInput', feeTier: 3000,
        slippageBps: 100, // 1%
      });

      // amountOutMinimum = 10000 * (10000 - 100) / 10000 = 9900
      expect(q.amountWithSlippage).toBe(9900n);
    });

    it('throws on zero amountOut (no liquidity)', async () => {
      const tool = makeTool();
      getMockClient().simulateContract.mockResolvedValueOnce({
        result: [0n, 0n, 0n, 0n],
      });

      await expect(tool.quote({
        tokenIn: USDC, tokenOut: WETH,
        amount: 1000n, direction: 'exactInput', feeTier: 3000,
      })).rejects.toThrow('zero amountOut');
    });
  });

  // ── quote: exactOutput ─────────────────────────────────────────────────

  describe('quote — exactOutput', () => {
    it('returns correct quote fields', async () => {
      const tool = makeTool();
      getMockClient().simulateContract.mockResolvedValueOnce({
        result: [100n * 10n ** 6n, 0n, 0n, 0n], // amountIn = 100 USDC
      });

      const q = await tool.quote({
        tokenIn: USDC, tokenOut: WETH,
        amount: 1n * 10n ** 18n, // want 1 WETH
        direction: 'exactOutput', feeTier: 3000,
      });

      expect(q.amountIn).toBe(100n * 10n ** 6n);
      expect(q.amountOut).toBe(1n * 10n ** 18n);
    });

    it('applies slippage as amountInMaximum (upward)', async () => {
      const tool = makeTool();
      getMockClient().simulateContract.mockResolvedValueOnce({
        result: [10_000n, 0n, 0n, 0n],
      });

      const q = await tool.quote({
        tokenIn: USDC, tokenOut: WETH,
        amount: 1000n, direction: 'exactOutput', feeTier: 3000,
        slippageBps: 50,
      });

      // amountInMaximum = 10000 * (10000 + 50) / 10000 = 10050
      expect(q.amountWithSlippage).toBe(10050n);
    });

    it('throws on zero amountIn (no liquidity)', async () => {
      const tool = makeTool();
      getMockClient().simulateContract.mockResolvedValueOnce({
        result: [0n, 0n, 0n, 0n],
      });

      await expect(tool.quote({
        tokenIn: USDC, tokenOut: WETH,
        amount: 1000n, direction: 'exactOutput', feeTier: 3000,
      })).rejects.toThrow('zero amountIn');
    });
  });

  // ── fee tier auto-detection ────────────────────────────────────────────

  describe('fee tier auto-detection', () => {
    it('uses first successful fee tier (3000)', async () => {
      const tool = makeTool();
      getMockClient().simulateContract.mockResolvedValueOnce({
        result: [9000n, 0n, 0n, 0n],
      });

      const q = await tool.quote({
        tokenIn: USDC, tokenOut: WETH,
        amount: 1000n, direction: 'exactInput',
        // no feeTier — auto detect
      });

      expect(q.feeTier).toBe(3000);
      expect(getMockClient().simulateContract).toHaveBeenCalledTimes(1);
    });

    it('falls through to 500 if 3000 fails', async () => {
      const tool = makeTool();
      getMockClient().simulateContract
        .mockRejectedValueOnce(new Error('no pool'))      // 3000 fails
        .mockResolvedValueOnce({ result: [9000n, 0n, 0n, 0n] }); // 500 succeeds

      const q = await tool.quote({
        tokenIn: USDC, tokenOut: WETH,
        amount: 1000n, direction: 'exactInput',
      });

      expect(q.feeTier).toBe(500);
      expect(getMockClient().simulateContract).toHaveBeenCalledTimes(2);
    });

    it('throws if all fee tiers fail', async () => {
      const tool = makeTool();
      getMockClient().simulateContract
        .mockRejectedValue(new Error('no pool'));

      await expect(tool.quote({
        tokenIn: USDC, tokenOut: WETH,
        amount: 1000n, direction: 'exactInput',
      })).rejects.toThrow('no liquidity found');
    });
  });

  // ── buildCalldata ──────────────────────────────────────────────────────

  describe('buildCalldata', () => {
    const baseQuote = {
      tokenIn:           USDC,
      tokenOut:          WETH,
      amountIn:          100n * 10n ** 6n,
      amountOut:         50n * 10n ** 18n,
      feeTier:           3000 as const,
      amountWithSlippage: 49n * 10n ** 18n,
      priceImpactBps:    30,
      sqrtPriceLimitX96: 0n,
    };

    it('exactInput: selector matches IntentRegistry.EXACT_INPUT_SINGLE', () => {
      const tool = makeTool();
      const result = tool.buildCalldata(
        baseQuote,
        { tokenIn: USDC, tokenOut: WETH, amount: 100n * 10n ** 6n, direction: 'exactInput', feeTier: 3000 },
        ACCOUNT,
      );

      expect(result.selector).toBe(SELECTORS.exactInputSingle);
      expect(result.target).toBe(SWAP_ROUTER);

      // Verify calldata decodes correctly as exactInputSingle
      const decoded = decodeFunctionData({ abi: SWAP_ROUTER_ABI, data: result.calldata });
      expect(decoded.functionName).toBe('exactInputSingle');
    });

    it('exactOutput: selector matches IntentRegistry.EXACT_OUTPUT_SINGLE', () => {
      const tool = makeTool();
      const outputQuote = { ...baseQuote, amountWithSlippage: 101n * 10n ** 6n };

      const result = tool.buildCalldata(
        outputQuote,
        { tokenIn: USDC, tokenOut: WETH, amount: 50n * 10n ** 18n, direction: 'exactOutput', feeTier: 3000 },
        ACCOUNT,
      );

      // result.selector is the explicit value set by buildCalldata
      expect(result.selector).toBe(SELECTORS.exactOutputSingle);

      // Verify calldata decodes correctly as exactOutputSingle
      const decoded = decodeFunctionData({ abi: SWAP_ROUTER_ABI, data: result.calldata });
      expect(decoded.functionName).toBe('exactOutputSingle');
    });

    it('S2: recipient in calldata is always the provided AccountERC7579', () => {
      const tool = makeTool();
      const result = tool.buildCalldata(
        baseQuote,
        { tokenIn: USDC, tokenOut: WETH, amount: 100n * 10n ** 6n, direction: 'exactInput', feeTier: 3000 },
        ACCOUNT,
      );

      // Decode the calldata and verify recipient
      const decoded = decodeFunctionData({
        abi:  SWAP_ROUTER_ABI,
        data: result.calldata,
      });

      const params = decoded.args[0] as { recipient: string };
      expect(params.recipient.toLowerCase()).toBe(ACCOUNT.toLowerCase());
    });

    it('S2: recipient is NOT the zero address or an arbitrary address', () => {
      const tool = makeTool();
      const ATTACKER = '0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead' as const;

      // Tool always uses the provided recipient — caller must pass AccountERC7579
      const result = tool.buildCalldata(baseQuote, {
        tokenIn: USDC, tokenOut: WETH, amount: 100n * 10n ** 6n, direction: 'exactInput', feeTier: 3000,
      }, ACCOUNT);

      const decoded = decodeFunctionData({ abi: SWAP_ROUTER_ABI, data: result.calldata });
      const params = decoded.args[0] as { recipient: string };

      expect(params.recipient.toLowerCase()).not.toBe(ATTACKER.toLowerCase());
      expect(params.recipient.toLowerCase()).not.toBe('0x0000000000000000000000000000000000000000');
    });

    it('exactInput: amountOutMinimum equals quote.amountWithSlippage', () => {
      const tool = makeTool();
      const result = tool.buildCalldata(baseQuote, {
        tokenIn: USDC, tokenOut: WETH, amount: 100n * 10n ** 6n, direction: 'exactInput', feeTier: 3000,
      }, ACCOUNT);

      const decoded = decodeFunctionData({ abi: SWAP_ROUTER_ABI, data: result.calldata });
      const params = decoded.args[0] as { amountOutMinimum: bigint };

      expect(params.amountOutMinimum).toBe(baseQuote.amountWithSlippage);
    });

    it('exactOutput: amountInMaximum equals quote.amountWithSlippage', () => {
      const tool = makeTool();
      const outputQuote = { ...baseQuote, amountWithSlippage: 101n * 10n ** 6n };

      const result = tool.buildCalldata(outputQuote, {
        tokenIn: USDC, tokenOut: WETH, amount: 50n * 10n ** 18n, direction: 'exactOutput', feeTier: 3000,
      }, ACCOUNT);

      const decoded = decodeFunctionData({ abi: SWAP_ROUTER_ABI, data: result.calldata });
      const params = decoded.args[0] as { amountInMaximum: bigint };

      expect(params.amountInMaximum).toBe(outputQuote.amountWithSlippage);
    });

    it('sqrtPriceLimitX96 is always 0 (no price limit in MVP)', () => {
      const tool = makeTool();
      const result = tool.buildCalldata(baseQuote, {
        tokenIn: USDC, tokenOut: WETH, amount: 100n * 10n ** 6n, direction: 'exactInput', feeTier: 3000,
      }, ACCOUNT);

      const decoded = decodeFunctionData({ abi: SWAP_ROUTER_ABI, data: result.calldata });
      const params = decoded.args[0] as { sqrtPriceLimitX96: bigint };

      expect(params.sqrtPriceLimitX96).toBe(0n);
    });

    it('fee tier in calldata matches quote.feeTier', () => {
      const tool = makeTool();
      const result = tool.buildCalldata(baseQuote, {
        tokenIn: USDC, tokenOut: WETH, amount: 100n * 10n ** 6n, direction: 'exactInput', feeTier: 3000,
      }, ACCOUNT);

      const decoded = decodeFunctionData({ abi: SWAP_ROUTER_ABI, data: result.calldata });
      const params = decoded.args[0] as { fee: number };

      expect(params.fee).toBe(3000);
    });
  });

  // ── quoteAndBuild ─────────────────────────────────────────────────────

  describe('quoteAndBuild', () => {
    it('combines quote and buildCalldata correctly', async () => {
      const tool = makeTool();
      getMockClient().simulateContract.mockResolvedValueOnce({
        result: [50n * 10n ** 18n, 0n, 0n, 0n],
      });

      const result = await tool.quoteAndBuild({
        tokenIn:   USDC,
        tokenOut:  WETH,
        amount:    100n * 10n ** 6n,
        direction: 'exactInput',
        feeTier:   3000,
      }, ACCOUNT);

      expect(result.target).toBe(SWAP_ROUTER);
      expect(result.recipient).toBe(ACCOUNT);
      expect(result.selector).toBe(SELECTORS.exactInputSingle);
      expect(result.quote.amountOut).toBe(50n * 10n ** 18n);
    });
  });
});
