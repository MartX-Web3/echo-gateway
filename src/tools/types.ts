/**
 * Shared types for Echo Gateway tools.
 *
 * A "tool" in Echo Gateway is a module that:
 *   1. Receives a high-level intent from the agent (via MCP or PreValidator)
 *   2. Calls an on-chain protocol (Uniswap, Aave, etc.) to get a quote
 *   3. Returns ABI-encoded calldata ready to be wrapped in a UserOperation
 *
 * The Action Builder pattern:
 *   - The tool builds calldata — the agent never touches calldata directly
 *   - recipient is always hardcoded to user EOA (S2 enforcement)
 *   - The Validator independently re-verifies recipient on-chain
 */

import type { Address, Hex } from 'viem';

/** A swap intent from the agent: what to swap, how much, slippage. */
export interface SwapIntent {
  /** Token to spend (input token). ERC-20 address. */
  tokenIn: Address;
  /** Token to receive (output token). ERC-20 address. */
  tokenOut: Address;
  /**
   * Amount to swap, in token units (not USD).
   * For exactInput: amount of tokenIn to spend.
   * For exactOutput: amount of tokenOut to receive.
   */
  amount: bigint;
  /**
   * Swap direction:
   *   'exactInput'  — spend exactly `amount` of tokenIn, receive ≥ minOut
   *   'exactOutput' — receive exactly `amount` of tokenOut, spend ≤ maxIn
   */
  direction: 'exactInput' | 'exactOutput';
  /**
   * Slippage tolerance as basis points (1 bp = 0.01%).
   * Default: 50 bps = 0.5%.
   * For exactInput:  minAmountOut = quoted * (10000 - slippageBps) / 10000
   * For exactOutput: maxAmountIn  = quoted * (10000 + slippageBps) / 10000
   */
  slippageBps?: number;
  /**
   * Uniswap V3 fee tier in bps * 100 (i.e. the uint24 fee param).
   *   500   = 0.05%  (stable pairs)
   *   3000  = 0.3%   (standard)
   *   10000 = 1%     (exotic)
   * If omitted, UniswapV3Tool will try 3000 first, then 500, then 10000.
   */
  feeTier?: 500 | 3000 | 10000;
  /**
   * Deadline offset in seconds from now.
   * Default: 300 (5 minutes).
   */
  deadlineOffsetSecs?: number;
}

/** Quote returned by the tool before building calldata. */
export interface SwapQuote {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  amountOut: bigint;
  feeTier: 500 | 3000 | 10000;
  /** amountOut after slippage (for exactInput) or amountIn after slippage (for exactOutput) */
  amountWithSlippage: bigint;
  /** Estimated price impact in bps */
  priceImpactBps: number;
  /** sqrtPriceLimitX96 — always 0 for MVP (no price limit) */
  sqrtPriceLimitX96: bigint;
}

/** Result from building calldata for a swap. */
export interface SwapCalldata {
  /** ABI-encoded exactInputSingle or exactOutputSingle call */
  calldata: Hex;
  /** The Uniswap V3 SwapRouter address (= allowedTargets entry) */
  target: Address;
  /** Function selector (used by PreValidator to verify against allowedSelectors) */
  selector: Hex;
  /** The quote used to build this calldata */
  quote: SwapQuote;
  /** recipient hardcoded to user EOA — never the agent */
  recipient: Address;
}
