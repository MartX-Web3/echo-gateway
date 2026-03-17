/**
 * MCP tool input and output types for Echo Gateway.
 * These are the JSON shapes that the agent sends and receives.
 * All bigint values are serialised as decimal strings over the wire.
 */

import type { Address, Hex } from 'viem';

// ── Shared ─────────────────────────────────────────────────────────────────

/** All amounts are decimal strings (e.g. "100000000" for 100 USDC at 6 decimals). */
export type AmountString = string;

export interface McpError {
  error:  true;
  code:   string;
  reason: string;
}

export interface McpTxResult {
  userOpHash: Hex;
  txHash:     Hex;
  amountIn:   AmountString;
  amountOut:  AmountString;
  feeTier:    number;
}

// ── MCP-01: echo_submit_intent ─────────────────────────────────────────────

export interface SubmitIntentInput {
  instanceId:    Hex;
  tokenIn:       Address;
  tokenOut:      Address;
  /** Amount in token units as decimal string */
  amount:        AmountString;
  direction:     'exactInput' | 'exactOutput';
  slippageBps?:  number;
  feeTier?:      500 | 3000 | 10000;
}

export type SubmitIntentOutput = McpTxResult | McpError;

// ── MCP-02: echo_create_session ────────────────────────────────────────────

export interface CreateSessionInput {
  instanceId:     Hex;
  tokenIn:        Address;
  tokenOut:       Address;
  maxAmountPerOp: AmountString;
  totalBudget:    AmountString;
  maxOpsPerDay:   number;
  /** Unix timestamp (seconds) */
  sessionExpiry:  number;
}

export interface CreateSessionOutput {
  sessionId:      Hex;
  sessionExpiry:  number;
  totalBudget:    AmountString;
  maxOpsPerDay:   number;
  /** Calldata for the user to sign and submit via Dashboard (method A) */
  pendingTx: {
    to:       Address;
    calldata: Hex;
    chainId:  number;
  };
}

// ── MCP-03: echo_execute_session ───────────────────────────────────────────

export interface ExecuteSessionInput {
  instanceId:   Hex;
  sessionId:    Hex;
  amount:       AmountString;
  slippageBps?: number;
}

export type ExecuteSessionOutput = McpTxResult | McpError;

// ── MCP-04: echo_list_sessions ─────────────────────────────────────────────

export interface ListSessionsInput {
  instanceId: Hex;
}

export interface SessionSummary {
  sessionId:      Hex;
  tokenIn:        Address;
  tokenOut:       Address;
  maxAmountPerOp: AmountString;
  totalBudget:    AmountString;
  totalSpent:     AmountString;
  maxOpsPerDay:   number;
  dailyOps:       number;
  sessionExpiry:  number;
  active:         boolean;
}

export interface ListSessionsOutput {
  sessions: SessionSummary[];
}

// ── MCP-05: echo_revoke_session ────────────────────────────────────────────

export interface RevokeSessionInput {
  sessionId: Hex;
}

export interface RevokeSessionOutput {
  revoked:    boolean;
  sessionId:  Hex;
  /** Calldata for user to sign via Dashboard (method A) */
  pendingTx: {
    to:       Address;
    calldata: Hex;
    chainId:  number;
  };
}

// ── MCP-06: echo_get_policy ────────────────────────────────────────────────

export interface GetPolicyInput {
  instanceId: Hex;
}

export interface TokenLimitSummary {
  token:      Address;
  maxPerOp:   AmountString;
  maxPerDay:  AmountString;
  dailySpent: AmountString;
}

export interface GetPolicyOutput {
  instanceId:        Hex;
  paused:            boolean;
  expiry:            number;
  globalTotalBudget: AmountString;
  globalTotalSpent:  AmountString;
  globalMaxPerDay:   AmountString;
  globalDailySpent:  AmountString;
  explorationBudget: AmountString;
  explorationSpent:  AmountString;
  tokenLimits:       TokenLimitSummary[];
}

// ── MCP-07: echo_pause_instance ────────────────────────────────────────────

export interface PauseInstanceInput {
  instanceId: Hex;
}

export interface PauseInstanceOutput {
  paused:     boolean;
  instanceId: Hex;
  /** Calldata for user to sign via Dashboard (method A) */
  pendingTx: {
    to:       Address;
    calldata: Hex;
    chainId:  number;
  };
}
