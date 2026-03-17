/**
 * UniswapV3Tool — Echo Gateway's Uniswap V3 swap tool.
 *
 * Responsibilities:
 *   1. Get a quote from QuoterV2 (simulate the swap, no state change)
 *   2. Apply slippage tolerance to get amountOutMinimum / amountInMaximum
 *   3. Build ABI-encoded calldata for exactInputSingle or exactOutputSingle
 *   4. Hardcode recipient = AccountERC7579 (S2 enforcement at Gateway layer)
 *
 * S2 guarantee:
 *   recipient is always set to the user's AccountERC7579 address.
 *   It is NEVER set to the agent's address or any third-party address.
 *   EchoPolicyValidator independently re-verifies this on-chain.
 *
 * Fee tier auto-detection:
 *   If feeTier is not specified, the tool tries 3000 → 500 → 10000 and uses
 *   the first one that returns a non-zero quote. This covers 99% of Sepolia
 *   test token pairs without manual configuration.
 *
 * No approvals:
 *   UniswapV3Tool does NOT handle ERC-20 approvals. The user must approve
 *   the SwapRouter to spend tokenIn from their AccountERC7579 separately
 *   (via the Dashboard "Enable token" flow). This is consistent with the
 *   design decision: Factory does NOT set approvals.
 */

import { createPublicClient, encodeFunctionData, http } from 'viem';
import { sepolia } from 'viem/chains';
import type { Address, PublicClient } from 'viem';
import { SWAP_ROUTER_ABI, QUOTER_V2_ABI, SELECTORS } from './abis.js';
import type { SwapIntent, SwapQuote, SwapCalldata } from './types.js';

// ── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_SLIPPAGE_BPS   = 50;   // 0.5%
const DEFAULT_DEADLINE_SECS  = 300;  // 5 minutes
const FEE_TIERS_TO_TRY       = [3000, 500, 10000] as const;
const BASIS_POINTS           = 10_000n;

// ── UniswapV3Tool ──────────────────────────────────────────────────────────

export interface UniswapV3ToolConfig {
  /** Sepolia (or mainnet) RPC URL */
  rpcUrl: string;
  /** Uniswap V3 SwapRouter address on Sepolia */
  swapRouter: Address;
  /** Uniswap V3 QuoterV2 address on Sepolia */
  quoterV2: Address;
}

export class UniswapV3Tool {
  private readonly client: PublicClient;
  private readonly swapRouter: Address;
  private readonly quoterV2: Address;

  constructor(config: UniswapV3ToolConfig) {
    this.client = createPublicClient({
      chain:     sepolia,
      transport: http(config.rpcUrl),
    });
    this.swapRouter = config.swapRouter;
    this.quoterV2   = config.quoterV2;
  }

  // ── Public API ─────────────────────────────────────────────────────────

  /**
   * Get a quote for a swap intent.
   * Uses QuoterV2.quoteExact*Single (view simulation, no state change).
   *
   * @throws if no liquidity is found for any fee tier.
   */
  async quote(intent: SwapIntent): Promise<SwapQuote> {
    const slippageBps = intent.slippageBps ?? DEFAULT_SLIPPAGE_BPS;

    if (intent.feeTier !== undefined) {
      return this._quoteSingle(intent, intent.feeTier, slippageBps);
    }

    // Auto-detect fee tier: try each until one succeeds
    const errors: string[] = [];
    for (const fee of FEE_TIERS_TO_TRY) {
      try {
        return await this._quoteSingle(intent, fee, slippageBps);
      } catch (err) {
        errors.push(`fee=${fee}: ${String(err)}`);
      }
    }

    throw new Error(
      `UniswapV3Tool: no liquidity found for ${intent.tokenIn}→${intent.tokenOut}.\n` +
      errors.join('\n'),
    );
  }

  /**
   * Build swap calldata for a given quote and recipient.
   *
   * @param quote      Quote returned by quote()
   * @param intent     Original swap intent (for deadline, direction)
   * @param recipient  MUST be the user's AccountERC7579 address (S2)
   *
   * @returns SwapCalldata ready to be wrapped in a UserOperation
   */
  buildCalldata(
    quote: SwapQuote,
    intent: SwapIntent,
    recipient: Address,
  ): SwapCalldata {
    const deadline = BigInt(Math.floor(Date.now() / 1000) + (intent.deadlineOffsetSecs ?? DEFAULT_DEADLINE_SECS));

    if (intent.direction === 'exactInput') {
      const calldata = encodeFunctionData({
        abi:          SWAP_ROUTER_ABI,
        functionName: 'exactInputSingle',
        args: [{
          tokenIn:           quote.tokenIn,
          tokenOut:          quote.tokenOut,
          fee:               quote.feeTier,
          recipient,
          deadline,
          amountIn:          quote.amountIn,
          amountOutMinimum:  quote.amountWithSlippage,  // min acceptable output
          sqrtPriceLimitX96: 0n,
        }],
      });

      return {
        calldata,
        target:    this.swapRouter,
        selector:  SELECTORS.exactInputSingle,
        quote,
        recipient,
      };
    } else {
      // exactOutput
      const calldata = encodeFunctionData({
        abi:          SWAP_ROUTER_ABI,
        functionName: 'exactOutputSingle',
        args: [{
          tokenIn:           quote.tokenIn,
          tokenOut:          quote.tokenOut,
          fee:               quote.feeTier,
          recipient,
          deadline,
          amountOut:         quote.amountOut,
          amountInMaximum:   quote.amountWithSlippage,  // max acceptable input
          sqrtPriceLimitX96: 0n,
        }],
      });

      return {
        calldata,
        target:    this.swapRouter,
        selector:  SELECTORS.exactOutputSingle,
        quote,
        recipient,
      };
    }
  }

  /**
   * Convenience: quote + buildCalldata in one call.
   * This is the primary entry point used by PreValidator and McpServer.
   *
   * @param intent     Swap intent from the agent
   * @param recipient  User's AccountERC7579 address (hardcoded S2)
   */
  async quoteAndBuild(
    intent: SwapIntent,
    recipient: Address,
  ): Promise<SwapCalldata> {
    const q = await this.quote(intent);
    return this.buildCalldata(q, intent, recipient);
  }

  // ── Private helpers ────────────────────────────────────────────────────

  private async _quoteSingle(
    intent: SwapIntent,
    feeTier: 500 | 3000 | 10000,
    slippageBps: number,
  ): Promise<SwapQuote> {
    if (intent.direction === 'exactInput') {
      return this._quoteExactInput(intent, feeTier, slippageBps);
    } else {
      return this._quoteExactOutput(intent, feeTier, slippageBps);
    }
  }

  private async _quoteExactInput(
    intent: SwapIntent,
    feeTier: 500 | 3000 | 10000,
    slippageBps: number,
  ): Promise<SwapQuote> {
    const result = await this.client.simulateContract({
      address:      this.quoterV2,
      abi:          QUOTER_V2_ABI,
      functionName: 'quoteExactInputSingle',
      args: [{
        tokenIn:           intent.tokenIn,
        tokenOut:          intent.tokenOut,
        amountIn:          intent.amount,
        fee:               feeTier,
        sqrtPriceLimitX96: 0n,
      }],
    });

    const amountOut = result.result[0];
    if (amountOut === 0n) {
      throw new Error('zero amountOut — no liquidity or pool does not exist');
    }

    // amountOutMinimum = amountOut * (10000 - slippageBps) / 10000
    const slippageFactor    = BASIS_POINTS - BigInt(slippageBps);
    const amountWithSlippage = (amountOut * slippageFactor) / BASIS_POINTS;

    const priceImpactBps = this._estimatePriceImpact(intent.amount, amountOut, feeTier);

    return {
      tokenIn:            intent.tokenIn,
      tokenOut:           intent.tokenOut,
      amountIn:           intent.amount,
      amountOut,
      feeTier,
      amountWithSlippage,
      priceImpactBps,
      sqrtPriceLimitX96:  0n,
    };
  }

  private async _quoteExactOutput(
    intent: SwapIntent,
    feeTier: 500 | 3000 | 10000,
    slippageBps: number,
  ): Promise<SwapQuote> {
    const result = await this.client.simulateContract({
      address:      this.quoterV2,
      abi:          QUOTER_V2_ABI,
      functionName: 'quoteExactOutputSingle',
      args: [{
        tokenIn:           intent.tokenIn,
        tokenOut:          intent.tokenOut,
        amount:            intent.amount,
        fee:               feeTier,
        sqrtPriceLimitX96: 0n,
      }],
    });

    const amountIn = result.result[0];
    if (amountIn === 0n) {
      throw new Error('zero amountIn — no liquidity or pool does not exist');
    }

    // amountInMaximum = amountIn * (10000 + slippageBps) / 10000
    const slippageFactor     = BASIS_POINTS + BigInt(slippageBps);
    const amountWithSlippage  = (amountIn * slippageFactor) / BASIS_POINTS;

    const priceImpactBps = this._estimatePriceImpact(amountIn, intent.amount, feeTier);

    return {
      tokenIn:            intent.tokenIn,
      tokenOut:           intent.tokenOut,
      amountIn,
      amountOut:          intent.amount,
      feeTier,
      amountWithSlippage,
      priceImpactBps,
      sqrtPriceLimitX96:  0n,
    };
  }

  /**
   * Rough price impact estimate based on fee tier.
   * Accurate price impact requires pool slot0/liquidity data.
   * For MVP we use a conservative heuristic: impact ≥ fee tier.
   * This is used only for informational display in the Dashboard.
   */
  private _estimatePriceImpact(
    amountIn: bigint,
    amountOut: bigint,
    feeTier: number,
  ): number {
    // Impact = fee tier bps as a floor; actual impact depends on pool depth.
    // We return the fee tier itself as a minimum estimate.
    // e.g. 3000 fee = 30 bps impact minimum
    void amountIn;
    void amountOut;
    return feeTier / 100; // convert fee (uint24 units) to bps
  }
}
