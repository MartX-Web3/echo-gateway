/**
 * McpServer — Echo Gateway's MCP server.
 *
 * Exposes 7 MCP tools to agent frameworks (OpenClaw, LangChain, etc.):
 *   MCP-01  echo_submit_intent      real-time swap
 *   MCP-02  echo_create_session     create autonomous session
 *   MCP-03  echo_execute_session    execute within session
 *   MCP-04  echo_list_sessions      list active sessions
 *   MCP-05  echo_revoke_session     revoke session (returns pendingTx)
 *   MCP-06  echo_get_policy         read policy state
 *   MCP-07  echo_pause_instance     emergency pause (returns pendingTx)
 *
 * MCP-05/07 return a pendingTx (method A) for the user to sign via Dashboard.
 * The gateway does not hold the user's EOA private key.
 *
 * Transport: stdio (default for OpenClaw local MCP)
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { Server }   from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { createPublicClient, encodeFunctionData, http, keccak256, toBytes } from 'viem';
import { sepolia } from 'viem/chains';
import type { Address, Hex, PublicClient } from 'viem';

import { KeyStore }      from '../keystore/KeyStore.js';
import { UniswapV3Tool }  from '../tools/UniswapV3Tool.js';
import { PreValidator }   from '../validation/PreValidator.js';
import { UserOpBuilder }  from '../userop/UserOpBuilder.js';
import type { BundlerEip7702Auth } from '../userop/UserOpBuilder.js';
import { POLICY_REGISTRY_ABI } from '../contracts/PolicyRegistryABI.js';
import type { GatewayConfig }  from '../config/index.js';
import type {
  SubmitIntentInput, SubmitIntentOutput,
  CreateSessionInput, CreateSessionOutput,
  ExecuteSessionInput, ExecuteSessionOutput,
  ListSessionsInput, ListSessionsOutput,
  RevokeSessionInput, RevokeSessionOutput,
  GetPolicyInput, GetPolicyOutput,
  PauseInstanceInput, PauseInstanceOutput,
  McpError,
} from './types.js';

// ── McpServer ──────────────────────────────────────────────────────────────

export class McpServer {
  private readonly server:         Server;
  private readonly keyStore:       KeyStore;
  private readonly uniswap:        UniswapV3Tool;
  private readonly validator:      PreValidator;
  private readonly userOpBuilder:  UserOpBuilder;
  private readonly client:         PublicClient;
  private readonly config:         GatewayConfig;

  constructor(config: GatewayConfig, keyStore: KeyStore) {
    this.config   = config;
    this.keyStore = keyStore;

    this.uniswap = new UniswapV3Tool({
      rpcUrl:     config.sepoliaRpcUrl,
      swapRouter: config.contracts.uniswapV3Router,
      quoterV2:   config.contracts.uniswapV3Quoter,
    });

    this.validator = new PreValidator({
      rpcUrl:         config.sepoliaRpcUrl,
      policyRegistry: config.contracts.policyRegistry,
    });

    this.userOpBuilder = new UserOpBuilder({
      rpcUrl:     config.sepoliaRpcUrl,
      pimlicoUrl: `https://api.pimlico.io/v2/sepolia/rpc?apikey=${config.pimlicoApiKey}`,
    });

    this.client = createPublicClient({
      chain:     sepolia,
      transport: http(config.sepoliaRpcUrl),
    });

    this.server = new Server(
      { name: 'echo-gateway', version: '0.1.0' },
      { capabilities: { tools: {} } },
    );

    this._registerHandlers();
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    // Keep the event loop alive so the process does not exit when the HTTP
    // server is not running (e.g. EADDRINUSE in subprocess/Claude Desktop mode).
    process.stdin.resume();
    console.error('[Echo Gateway] MCP server ready (stdio)');
  }

  // ── Tool registration ──────────────────────────────────────────────────

  private _registerHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: TOOL_DEFINITIONS,
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const { name, arguments: args } = req.params;
      try {
        const result = await this._dispatch(name, args ?? {});
        return {
          content: [{ type: 'text', text: JSON.stringify(result, bigintReplacer, 2) }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text', text: JSON.stringify(mcpError('INTERNAL_ERROR', msg)) }],
          isError: true,
        };
      }
    });
  }

  private async _dispatch(name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case 'echo_get_context':      return this._getContext();
      case 'echo_submit_intent':    return this._submitIntent(args as unknown as SubmitIntentInput);
      case 'echo_create_session':   return this._createSession(args as unknown as CreateSessionInput);
      case 'echo_execute_session':  return this._executeSession(args as unknown as ExecuteSessionInput);
      case 'echo_list_sessions':    return this._listSessions(args as unknown as ListSessionsInput);
      case 'echo_revoke_session':   return this._revokeSession(args as unknown as RevokeSessionInput);
      case 'echo_get_policy':       return this._getPolicy(args as unknown as GetPolicyInput);
      case 'echo_pause_instance':   return this._pauseInstance(args as unknown as PauseInstanceInput);
      default: throw new Error(`Unknown tool: ${name}`);
    }
  }

  // ── MCP-01: echo_submit_intent ─────────────────────────────────────────

  private async _submitIntent(input: SubmitIntentInput): Promise<SubmitIntentOutput> {
    input = { ...input, instanceId: this._resolveInstanceId(input.instanceId) as typeof input.instanceId };
    const intent = {
      tokenIn:   input.tokenIn,
      tokenOut:  input.tokenOut,
      amount:    BigInt(input.amount),
      direction: input.direction,
      ...(input.slippageBps !== undefined && { slippageBps: input.slippageBps }),
      ...(input.feeTier     !== undefined && { feeTier:     input.feeTier     }),
    } satisfies import('../tools/types.js').SwapIntent;

    // Stage 1 — intent validation
    const r1 = await this.validator.validateIntent({
      instanceId: input.instanceId,
      intent,
      mode: 'realtime',
    });
    if (!r1.ok) return mcpError(r1.code, r1.reason);

    // Get account address for recipient
    const accountAddress = await this._getAccountAddress(input.instanceId);

    // Build calldata
    const swapCalldata = await this.uniswap.quoteAndBuild(intent, accountAddress);

    // Stage 2 — calldata validation
    const r2 = await this.validator.validateCalldata({
      instanceId: input.instanceId,
      accountAddress,
      swapCalldata,
      intent,
    });
    if (!r2.ok) return mcpError(r2.code, r2.reason);

    // Build and submit UserOp
    const sig = this.keyStore.buildRealtimeSig(input.instanceId);
    const result = await this._submitUserOpFull(
      accountAddress,
      swapCalldata.target,
      swapCalldata.calldata,
      sig,
    );

    return {
      ...result,
      amountIn:  swapCalldata.quote.amountIn.toString(),
      amountOut: swapCalldata.quote.amountOut.toString(),
      feeTier:   swapCalldata.quote.feeTier,
    };
  }

  // ── MCP-02: echo_create_session ────────────────────────────────────────

  private async _createSession(input: CreateSessionInput): Promise<CreateSessionOutput> {
    input = { ...input, instanceId: this._resolveInstanceId(input.instanceId) as typeof input.instanceId };
    // Generate session key and store it
    const { keyHash: sessionKeyHash } = await this.keyStore.addKey(
      `session-pending-${Date.now()}`,
      'session',
      `Session ${input.tokenIn}→${input.tokenOut}`,
      { expiresAt: input.sessionExpiry * 1000 },
    );

    // Build the createSession calldata for the user to sign
    const calldata = encodeFunctionData({
      abi:          POLICY_REGISTRY_ABI,
      functionName: 'createSession',
      args: [
        input.instanceId,
        sessionKeyHash,
        input.tokenIn,
        input.tokenOut,
        BigInt(input.maxAmountPerOp),
        BigInt(input.totalBudget),
        BigInt(input.maxOpsPerDay),
        BigInt(input.sessionExpiry),
      ],
    });

    return {
      sessionId:     sessionKeyHash, // placeholder — real sessionId comes from on-chain event
      sessionExpiry: input.sessionExpiry,
      totalBudget:   input.totalBudget,
      maxOpsPerDay:  input.maxOpsPerDay,
      pendingTx: {
        to:      this.config.contracts.policyRegistry,
        calldata,
        chainId: this.config.chainId,
      },
    };
  }

  // ── MCP-03: echo_execute_session ───────────────────────────────────────

  private async _executeSession(input: ExecuteSessionInput): Promise<ExecuteSessionOutput> {
    input = { ...input, instanceId: this._resolveInstanceId(input.instanceId) as typeof input.instanceId };
    // Read session to get tokenIn/tokenOut
    const sess = await this.client.readContract({
      address:      this.config.contracts.policyRegistry,
      abi:          POLICY_REGISTRY_ABI,
      functionName: 'getSessionValidation',
      args:         [input.sessionId],
    });

    const intent = {
      tokenIn:   sess.tokenIn  as Address,
      tokenOut:  sess.tokenOut as Address,
      amount:    BigInt(input.amount),
      direction: 'exactInput' as const,
      ...(input.slippageBps !== undefined && { slippageBps: input.slippageBps }),
    } satisfies import('../tools/types.js').SwapIntent;

    // Stage 1 — session validation
    const r1 = await this.validator.validateIntent({
      instanceId: input.instanceId,
      sessionId:  input.sessionId,
      intent,
      mode: 'session',
    });
    if (!r1.ok) return mcpError(r1.code, r1.reason);

    const accountAddress = await this._getAccountAddress(input.instanceId);
    const swapCalldata   = await this.uniswap.quoteAndBuild(intent, accountAddress);

    // Stage 2 — calldata validation
    const r2 = await this.validator.validateCalldata({
      instanceId: input.instanceId,
      accountAddress,
      swapCalldata,
      intent,
    });
    if (!r2.ok) return mcpError(r2.code, r2.reason);

    const sig = this.keyStore.buildSessionSig(input.sessionId);
    const result = await this._submitUserOpFull(
      accountAddress,
      swapCalldata.target,
      swapCalldata.calldata,
      sig,
    );

    return {
      ...result,
      amountIn:  swapCalldata.quote.amountIn.toString(),
      amountOut: swapCalldata.quote.amountOut.toString(),
      feeTier:   swapCalldata.quote.feeTier,
    };
  }

  // ── MCP-04: echo_list_sessions ─────────────────────────────────────────

  private async _listSessions(input: ListSessionsInput): Promise<ListSessionsOutput> {
    input = { ...input, instanceId: this._resolveInstanceId(input.instanceId) as typeof input.instanceId };
    // Get all session keys from keystore that belong to this instance
    const sessionKeys = this.keyStore.listKeys('session');

    const sessions = await Promise.all(
      sessionKeys.map(async (meta) => {
        try {
          const sess = await this.client.readContract({
            address:      this.config.contracts.policyRegistry,
            abi:          POLICY_REGISTRY_ABI,
            functionName: 'getSessionValidation',
            args:         [meta.id as Hex],
          });

          if (sess.instanceId.toLowerCase() !== input.instanceId.toLowerCase()) return null;

          return {
            sessionId:      meta.id as Hex,
            tokenIn:        sess.tokenIn  as Address,
            tokenOut:       sess.tokenOut as Address,
            maxAmountPerOp: sess.maxAmountPerOp.toString(),
            totalBudget:    sess.totalBudget.toString(),
            totalSpent:     sess.totalSpent.toString(),
            maxOpsPerDay:   Number(sess.maxOpsPerDay),
            dailyOps:       Number(sess.dailyOps),
            sessionExpiry:  Number(sess.sessionExpiry),
            active:         sess.active,
          };
        } catch {
          return null; // session not found on-chain yet (pending confirmation)
        }
      }),
    );

    return {
      sessions: sessions.filter((s): s is NonNullable<typeof s> => s !== null && s.active),
    };
  }

  // ── MCP-05: echo_revoke_session ────────────────────────────────────────

  private async _revokeSession(input: RevokeSessionInput): Promise<RevokeSessionOutput> {
    const calldata = encodeFunctionData({
      abi:          POLICY_REGISTRY_ABI,
      functionName: 'revokeSession',
      args:         [input.sessionId],
    });

    return {
      revoked:   true,
      sessionId: input.sessionId,
      pendingTx: {
        to:      this.config.contracts.policyRegistry,
        calldata,
        chainId: this.config.chainId,
      },
    };
  }

  // ── MCP-06: echo_get_policy ────────────────────────────────────────────

  private async _getPolicy(input: GetPolicyInput): Promise<GetPolicyOutput> {
    input = { ...input, instanceId: this._resolveInstanceId(input.instanceId) as typeof input.instanceId };
    const [inst, instFull] = await Promise.all([
      this.client.readContract({
        address:      this.config.contracts.policyRegistry,
        abi:          POLICY_REGISTRY_ABI,
        functionName: 'getInstanceValidation',
        args:         [input.instanceId],
      }),
      this.client.readContract({
        address:      this.config.contracts.policyRegistry,
        abi:          POLICY_REGISTRY_ABI,
        functionName: 'getInstance',
        args:         [input.instanceId],
      }),
    ]);

    // Fetch per-token limits for all tokens in tokenList
    const tokenLimits = await Promise.all(
      instFull.tokenList.map(async (token) => {
        const tl = await this.client.readContract({
          address:      this.config.contracts.policyRegistry,
          abi:          POLICY_REGISTRY_ABI,
          functionName: 'getTokenLimitValidation',
          args:         [input.instanceId, token as Address],
        });
        return {
          token:      token as Address,
          maxPerOp:   tl.maxPerOp.toString(),
          maxPerDay:  tl.maxPerDay.toString(),
          dailySpent: tl.dailySpent.toString(),
        };
      }),
    );

    return {
      instanceId:        input.instanceId,
      paused:            inst.paused,
      expiry:            Number(inst.expiry),
      globalTotalBudget: inst.globalTotalBudget.toString(),
      globalTotalSpent:  inst.globalTotalSpent.toString(),
      globalMaxPerDay:   inst.globalMaxPerDay.toString(),
      globalDailySpent:  inst.globalDailySpent.toString(),
      explorationBudget: inst.explorationBudget.toString(),
      explorationSpent:  inst.explorationSpent.toString(),
      tokenLimits,
    };
  }

  // ── MCP-07: echo_pause_instance ────────────────────────────────────────

  private async _pauseInstance(input: PauseInstanceInput): Promise<PauseInstanceOutput> {
    input = { ...input, instanceId: this._resolveInstanceId(input.instanceId) as typeof input.instanceId };
    const calldata = encodeFunctionData({
      abi:          POLICY_REGISTRY_ABI,
      functionName: 'pauseInstance',
      args:         [input.instanceId],
    });

    return {
      paused:     true,
      instanceId: input.instanceId,
      pendingTx: {
        to:      this.config.contracts.policyRegistry,
        calldata,
        chainId: this.config.chainId,
      },
    };
  }

  // ── Private helpers ────────────────────────────────────────────────────

  /**
   * Resolve UserOp.sender (user EOA) for a PolicyInstance from KeyStore label `account:0x...`.
   * Token balances and SwapRouter approvals must be on this EOA.
   */
  // ── MCP-00: echo_get_context ──────────────────────────────────────────
  private _getContext() {
    try {
      const instanceId = this._resolveInstanceId();
      const keys = this.keyStore.listKeys('execute');
      const key = keys.find(k => k.id === instanceId) ?? keys[0];
      const label = key?.label ?? '';
      return {
        instanceId,
        accountAddress: label.match(/account:(0x[0-9a-fA-F]{40})/)?.[1] ?? null,
        ownerAddress:   label.match(/owner:(0x[0-9a-fA-F]{40})/)?.[1] ?? null,
        name:           label.split('|')[0] ?? 'My Account',
        network:        'sepolia',
        chainId:        this.config.chainId,
        policyRegistry: this.config.contracts.policyRegistry,
        echoDelegationModule: this.config.contracts.echoDelegationModule,
      };
    } catch (err) {
      return { error: true, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  private _resolveInstanceId(instanceId?: string): Hex {
    if (instanceId && instanceId.length === 66) return instanceId as Hex;
    // Read active context set by Dashboard on wallet connect
    try {
      const ctxPath = (this.keyStore as unknown as { path: string }).path
        .replace('keystore.json', 'context.json');
      if (existsSync(ctxPath)) {
        const ctx = JSON.parse(readFileSync(ctxPath, 'utf8')) as { activeInstanceId: string };
        if (ctx.activeInstanceId) return ctx.activeInstanceId as Hex;
      }
    } catch { /* context.json not found, fall through */ }
    // Fallback: first registered key
    const keys = this.keyStore.listKeys('execute');
    if (keys.length === 0) throw new Error(
      'No Echo context found. Open the Dashboard and link your policy instance (EOA).'
    );
    return keys[0]!.id as Hex;
  }

  /** User EOA — UserOperation.sender (must match EIP-7702 registration + token balances/allowances). */
  private async _getAccountAddress(instanceId: Hex): Promise<Address> {
    const meta = this.keyStore.getKeyMeta(instanceId);
    if (!meta) {
      throw new Error(
        `No execute key found for instanceId=${instanceId}. ` +
        `Is the gateway unlocked and the instance registered?`
      );
    }
    // Sender EOA stored in key label: "account:0x..." (same as swap recipient)
    const match = meta.label.match(/account:(0x[0-9a-fA-F]{40})/);
    if (!match?.[1]) {
      throw new Error(
        `Cannot determine EOA address for instanceId=${instanceId}. ` +
        `Key label must include "account:0x..." (UserOp.sender).`
      );
    }
    return match[1] as Address;
  }

  /**
   * Optional `eip7702Auth` from context.json (written by Dashboard / tooling).
   * Required by Pimlico when sender is a 7702 EOA that has not yet had delegation activated.
   * Delegate address must be EchoDelegationModule.
   */
  private _readContextEip7702Auth(): BundlerEip7702Auth | undefined {
    try {
      const ctxPath = this.keyStore.path.replace('keystore.json', 'context.json');
      if (!existsSync(ctxPath)) return undefined;
      const raw = JSON.parse(readFileSync(ctxPath, 'utf8')) as { eip7702Auth?: BundlerEip7702Auth };
      return raw.eip7702Auth;
    } catch {
      return undefined;
    }
  }

  /**
   * Remove `eip7702Auth` from context.json after a successful UserOp that activated delegation.
   * Once delegation is set on-chain it is permanent — future UserOps do not need eip7702Auth.
   * A stale (old-nonce) auth would cause Pimlico to reject future UserOps, so we clear it now.
   */
  private _clearContextEip7702Auth(): void {
    try {
      const ctxPath = this.keyStore.path.replace('keystore.json', 'context.json');
      if (!existsSync(ctxPath)) return;
      const ctx = JSON.parse(readFileSync(ctxPath, 'utf8')) as Record<string, unknown>;
      if (!('eip7702Auth' in ctx)) return;
      delete ctx['eip7702Auth'];
      writeFileSync(ctxPath, JSON.stringify(ctx, null, 2), 'utf8');
    } catch { /* non-fatal — next UserOp will fail gracefully if auth is stale */ }
  }

  /**
   * Build and submit a UserOperation via Pimlico.
   * Uses Pimlico Verifying Paymaster — user does not need ETH on the EOA for gas when sponsored.
   */
  private async _submitUserOp(
    account:   Address,
    calldata:  Hex,
    signature: Hex,
  ): Promise<{ userOpHash: Hex; txHash: Hex }> {
    // UserOpBuilder wraps calldata in EchoDelegationModule.execute(),
    // fetches nonce, gets paymaster sponsorship, and submits via Pimlico.
    // The `calldata` here is the inner swap calldata (exactInputSingle etc).
    // UserOpBuilder extracts the target from SwapCalldata context — but since
    // McpServer only passes the inner calldata bytes, we need to pass the
    // target separately. Instead, we restructure: McpServer now passes
    // target + innerCalldata so UserOpBuilder can build the outer call.
    throw new Error(
      '_submitUserOp must be called via _submitUserOpFull with target + innerCalldata'
    );
  }

  /**
   * Full UserOp submission with target + innerCalldata.
   * Used by _submitIntent and _executeSession.
   */
  private async _submitUserOpFull(
    account:       Address,
    target:        Address,
    innerCalldata: Hex,
    signature:     Hex,
  ): Promise<{ userOpHash: Hex; txHash: Hex }> {
    const eip7702Auth = this._readContextEip7702Auth();
    const result = await this.userOpBuilder.submit(account, target, innerCalldata, signature, {
      ...(eip7702Auth ? { eip7702Auth } : {}),
    });
    // If we submitted with eip7702Auth, delegation is now permanently active on-chain.
    // Clear the stored auth so future UserOps are submitted as normal type-2 (not type-4).
    // A stale nonce in eip7702Auth would cause Pimlico to reject subsequent UserOps.
    if (eip7702Auth) this._clearContextEip7702Auth();
    return result;
  }
}

// ── Tool definitions ───────────────────────────────────────────────────────

const TOOL_DEFINITIONS = [
  {
    name:        'echo_get_context',
    description:
      'Get the current Echo context — instanceId, user EOA (UserOp.sender / swap recipient), owner wallet, and policy addresses. ' +
      'ALWAYS call this first before any other echo_ tool. ' +
      'Never ask the user for instanceId — retrieve it automatically with this tool.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name:        'echo_submit_intent',
    description:
      'Execute a swap immediately using the real-time Execute Key (EIP-7702 EOA as sender). ' +
      'Requires policy + EIP-7702 registration on-chain; user EOA must hold tokens and approve SwapRouter. ' +
      'Returns the transaction hash when the swap is confirmed on-chain.',
    inputSchema: {
      type: 'object',
      properties: {
        instanceId:   { type: 'string', description: 'PolicyInstance ID (bytes32 hex)' },
        tokenIn:      { type: 'string', description: 'Input token address' },
        tokenOut:     { type: 'string', description: 'Output token address' },
        amount:       { type: 'string', description: 'Amount in token units (decimal string)' },
        direction:    { type: 'string', enum: ['exactInput', 'exactOutput'] },
        slippageBps:  { type: 'number', description: 'Slippage tolerance in basis points (default 50 = 0.5%)' },
        feeTier:      { type: 'number', enum: [500, 3000, 10000], description: 'Uniswap V3 fee tier (auto-detected if omitted)' },
      },
      required: ['tokenIn', 'tokenOut', 'amount', 'direction'],
    },
  },
  {
    name:        'echo_create_session',
    description:
      'Create a SessionPolicy for autonomous recurring execution. ' +
      'Returns a pendingTx for the user to sign once via the Dashboard. ' +
      'After the user confirms, use echo_execute_session for each operation.',
    inputSchema: {
      type: 'object',
      properties: {
        instanceId:     { type: 'string' },
        tokenIn:        { type: 'string' },
        tokenOut:       { type: 'string' },
        maxAmountPerOp: { type: 'string', description: 'Max amount per swap (decimal string)' },
        totalBudget:    { type: 'string', description: 'Total session budget (decimal string)' },
        maxOpsPerDay:   { type: 'number' },
        sessionExpiry:  { type: 'number', description: 'Unix timestamp (seconds)' },
      },
      required: ['tokenIn', 'tokenOut', 'maxAmountPerOp', 'totalBudget', 'maxOpsPerDay', 'sessionExpiry'],
    },
  },
  {
    name:        'echo_execute_session',
    description:
      'Execute one operation within an existing session. ' +
      'Use this for autonomous scheduled tasks after echo_create_session. ' +
      'The session key is used — no user confirmation required.',
    inputSchema: {
      type: 'object',
      properties: {
        instanceId:  { type: 'string' },
        sessionId:   { type: 'string' },
        amount:      { type: 'string' },
        slippageBps: { type: 'number' },
      },
      required: ['sessionId', 'amount'],
    },
  },
  {
    name:        'echo_list_sessions',
    description: 'List all active sessions for a PolicyInstance.',
    inputSchema: {
      type: 'object',
      properties: {
        instanceId: { type: 'string' },
      },
      required: [],
    },
  },
  {
    name:        'echo_revoke_session',
    description:
      'Revoke an active session immediately. ' +
      'Returns a pendingTx for the user to sign via the Dashboard.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
      },
      required: ['sessionId'],
    },
  },
  {
    name:        'echo_get_policy',
    description:
      'Read the current state of a PolicyInstance including remaining budgets, ' +
      'daily spend, and per-token limits. Use this before planning a task.',
    inputSchema: {
      type: 'object',
      properties: {
        instanceId: { type: 'string' },
      },
      required: [],
    },
  },
  {
    name:        'echo_pause_instance',
    description:
      'Emergency pause — stops all agent operations immediately. ' +
      'Returns a pendingTx for the user to sign via the Dashboard. ' +
      'Use this if you detect suspicious activity.',
    inputSchema: {
      type: 'object',
      properties: {
        instanceId: { type: 'string' },
      },
      required: [],
    },
  },
] as const;

// ── Utilities ──────────────────────────────────────────────────────────────

function mcpError(code: string, reason: string): McpError {
  return { error: true, code, reason };
}

/** JSON.stringify replacer that serialises BigInt as decimal string. */
function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}