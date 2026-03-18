/**
 * UserOpBuilder — assembles and submits ERC-4337 PackedUserOperations.
 *
 * Gas payment: Pimlico Verifying Paymaster (pm_sponsorUserOperation).
 * Users do NOT need ETH in their AccountERC7579. Echo team's Pimlico
 * API credit covers gas.
 *
 * Pipeline:
 *   1. Wrap inner swap calldata → AccountERC7579.execute() outer call
 *   2. Fetch nonce from EntryPoint
 *   3. Call pm_sponsorUserOperation → paymasterAndData + gas estimates
 *   4. Attach signature (execute key or session key from KeyStore)
 *   5. eth_sendUserOperation → userOpHash
 *   6. Poll eth_getUserOperationReceipt → txHash
 *
 * callData layout (matches EchoPolicyValidator offsets):
 *   [0:4]     execute() selector
 *   [4:36]    mode = bytes32(0) = CALLTYPE_SINGLE
 *   [36:68]   ABI offset to executionCalldata
 *   [68:100]  length of executionCalldata
 *   [100:120] target (20 bytes packed)
 *   [120:152] value = 0 (uint256)
 *   [152:...]  innerCalldata (exactInputSingle / exactOutputSingle)
 */

import {
  createPublicClient,
  createClient,
  http,
  encodeFunctionData,
  encodePacked,
  pad,
  toHex,
  hexToBigInt,
} from 'viem';
import { sepolia } from 'viem/chains';
import type { Address, Hex, PublicClient } from 'viem';

// ── Constants ──────────────────────────────────────────────────────────────

const ENTRY_POINT_V07 = '0x0000000071727De22E5E9d8BAf0edAc6f37da032' as const;

/** ERC-7579 CALLTYPE_SINGLE mode = bytes32(0) */
const CALLTYPE_SINGLE = ('0x' + '00'.repeat(32)) as Hex;

/** Pad gas estimate by 20% to reduce revert risk */
const GAS_OVERHEAD_FACTOR = 120n;
const GAS_OVERHEAD_DENOM  = 100n;

/** Polling config */
const POLL_INITIAL_DELAY_MS = 2_000;
const POLL_MAX_ATTEMPTS     = 10;
const POLL_BACKOFF_FACTOR   = 1.5;

// ── ABIs ───────────────────────────────────────────────────────────────────

const ACCOUNT_EXECUTE_ABI = [
  {
    name: 'execute',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      { name: 'mode',               type: 'bytes32' },
      { name: 'executionCalldata',  type: 'bytes'   },
    ],
    outputs: [],
  },
] as const;

const ENTRY_POINT_ABI = [
  {
    name: 'getNonce',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'sender', type: 'address' },
      { name: 'key',    type: 'uint192' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

// ── Types ──────────────────────────────────────────────────────────────────

export interface UserOpBuilderConfig {
  rpcUrl:       string;
  pimlicoUrl:   string;  // https://api.pimlico.io/v2/sepolia/rpc?apikey=KEY
}

export interface SubmitResult {
  userOpHash: Hex;
  txHash:     Hex;
}

/** Minimal PackedUserOperation struct (EntryPoint v0.7) */
interface PackedUserOp {
  sender:               Address;
  nonce:                Hex;
  initCode:             Hex;
  callData:             Hex;
  accountGasLimits:     Hex;  // abi.encodePacked(verificationGasLimit, callGasLimit)
  preVerificationGas:   Hex;
  gasFees:              Hex;  // abi.encodePacked(maxPriorityFeePerGas, maxFeePerGas)
  paymasterAndData:     Hex;
  signature:            Hex;
}

// ── UserOpBuilder ──────────────────────────────────────────────────────────

export class UserOpBuilder {
  private readonly publicClient: PublicClient;
  private readonly pimlicoUrl:   string;

  constructor(config: UserOpBuilderConfig) {
    this.publicClient = createPublicClient({
      chain:     sepolia,
      transport: http(config.rpcUrl),
    });
    this.pimlicoUrl = config.pimlicoUrl;
  }

  // ── Public API ─────────────────────────────────────────────────────────

  /**
   * Build, sponsor, sign and submit a UserOperation.
   *
   * @param account      EchoAccount clone address (sender)
   * @param target       Uniswap V3 SwapRouter address
   * @param innerCalldata  ABI-encoded exactInputSingle / exactOutputSingle
   * @param signature    Pre-built Echo signature ([0x01][key] or [0x02][sid][key])
   */
  async submit(
    account:       Address,
    target:        Address,
    innerCalldata: Hex,
    signature:     Hex,
  ): Promise<SubmitResult> {

    // Step 1: Wrap innerCalldata into AccountERC7579.execute() calldata
    const outerCalldata = this._buildOuterCalldata(target, innerCalldata);

    // Step 2: Fetch nonce from EntryPoint
    const nonce = await this._getNonce(account);

    // Step 3: Build a partial UserOp (no gas fields yet, placeholder signature)
    const partialOp: PackedUserOp = {
      sender:             account,
      nonce:              toHex(nonce),
      initCode:           '0x',
      callData:           outerCalldata,
      accountGasLimits:   ('0x' + '00'.repeat(32)) as Hex,  // filled by sponsor
      preVerificationGas: '0x0',                     // filled by sponsor
      gasFees:            ('0x' + '00'.repeat(32)) as Hex,   // filled by sponsor
      paymasterAndData:   '0x',                      // filled by sponsor
      signature:          ('0x' + '00'.repeat(65)) as Hex,   // dummy for gas estimation
    };

    // Step 4: Call pm_sponsorUserOperation → get paymasterAndData + gas
    const sponsored = await this._sponsorUserOp(partialOp);

    // Step 5: Attach real signature
    const finalOp: PackedUserOp = { ...sponsored, signature };

    // Step 6: Submit
    const userOpHash = await this._sendUserOp(finalOp);

    // Step 7: Poll for receipt
    const txHash = await this._waitForReceipt(userOpHash);

    return { userOpHash, txHash };
  }

  // ── Private: calldata ──────────────────────────────────────────────────

  /**
   * Wrap innerCalldata into AccountERC7579.execute() call.
   *
   * executionCalldata = abi.encodePacked(target, uint256(0), innerCalldata)
   *
   * This produces the outer layout that EchoPolicyValidator parses:
   *   [100:120] target (20 bytes)
   *   [120:152] value = 0
   *   [152:...]  innerCalldata
   */
  private _buildOuterCalldata(target: Address, innerCalldata: Hex): Hex {
    // abi.encodePacked(target, uint256(0), innerCalldata)
    const executionCalldata = encodePacked(
      ['address', 'uint256', 'bytes'],
      [target, 0n, innerCalldata],
    );

    return encodeFunctionData({
      abi:          ACCOUNT_EXECUTE_ABI,
      functionName: 'execute',
      args:         [CALLTYPE_SINGLE, executionCalldata],
    });
  }

  // ── Private: nonce ─────────────────────────────────────────────────────

  private async _getNonce(account: Address): Promise<bigint> {
    return this.publicClient.readContract({
      address:      ENTRY_POINT_V07,
      abi:          ENTRY_POINT_ABI,
      functionName: 'getNonce',
      args:         [account, 0n],
    });
  }

  // ── Private: Pimlico paymaster ─────────────────────────────────────────

  /**
   * Call pm_sponsorUserOperation to get:
   *   - paymasterAndData (Pimlico Verifying Paymaster signature)
   *   - gas estimates (verificationGasLimit, callGasLimit, preVerificationGas,
   *                    maxFeePerGas, maxPriorityFeePerGas)
   */
  private async _sponsorUserOp(op: PackedUserOp): Promise<PackedUserOp> {
    const result = await this._rpc<{
      paymasterAndData:     Hex;
      preVerificationGas:   Hex;
      verificationGasLimit: Hex;
      callGasLimit:         Hex;
      maxFeePerGas:         Hex;
      maxPriorityFeePerGas: Hex;
    }>('pm_sponsorUserOperation', [
      this._opToRpcFormat(op),
      ENTRY_POINT_V07,
    ]);

    // Pad gas limits by 20%
    const verGas  = this._padGas(hexToBigInt(result.verificationGasLimit));
    const callGas = this._padGas(hexToBigInt(result.callGasLimit));

    return {
      ...op,
      accountGasLimits:   this._packUint128x2(verGas, callGas),
      preVerificationGas: result.preVerificationGas,
      gasFees:            this._packUint128x2(
        hexToBigInt(result.maxPriorityFeePerGas),
        hexToBigInt(result.maxFeePerGas),
      ),
      paymasterAndData: result.paymasterAndData,
    };
  }

  // ── Private: submit ────────────────────────────────────────────────────

  private async _sendUserOp(op: PackedUserOp): Promise<Hex> {
    return this._rpc<Hex>('eth_sendUserOperation', [
      this._opToRpcFormat(op),
      ENTRY_POINT_V07,
    ]);
  }

  // ── Private: receipt polling ───────────────────────────────────────────

  private async _waitForReceipt(userOpHash: Hex): Promise<Hex> {
    let delay   = POLL_INITIAL_DELAY_MS;
    let attempt = 0;

    while (attempt < POLL_MAX_ATTEMPTS) {
      await sleep(delay);
      attempt++;
      delay = Math.floor(delay * POLL_BACKOFF_FACTOR);

      const receipt = await this._rpc<{ receipt: { transactionHash: Hex } } | null>(
        'eth_getUserOperationReceipt',
        [userOpHash],
      );

      if (receipt?.receipt?.transactionHash) {
        return receipt.receipt.transactionHash;
      }
    }

    throw new Error(
      `UserOp ${userOpHash} not included after ${POLL_MAX_ATTEMPTS} attempts. ` +
      `Check Pimlico dashboard for status.`
    );
  }

  // ── Private: RPC ───────────────────────────────────────────────────────

  private async _rpc<T>(method: string, params: unknown[]): Promise<T> {
    const res = await fetch(this.pimlicoUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });

    if (!res.ok) {
      throw new Error(`Pimlico HTTP ${res.status}: ${await res.text()}`);
    }

    const json = await res.json() as { result?: T; error?: { message: string; code: number } };

    if (json.error) {
      throw new Error(`Pimlico RPC error ${json.error.code}: ${json.error.message}`);
    }

    return json.result as T;
  }

  // ── Private: formatting helpers ────────────────────────────────────────

  /**
   * Convert PackedUserOp to the JSON format Pimlico's RPC expects.
   * All BigInt fields must be hex strings.
   */
  private _opToRpcFormat(op: PackedUserOp): Record<string, unknown> {
    // Pimlico expects unpacked v0.7 fields (not the on-chain packed format)
    // Unpack accountGasLimits → verificationGasLimit + callGasLimit
    // Unpack gasFees → maxPriorityFeePerGas + maxFeePerGas
    // initCode → factory + factoryData (empty = no deployment)
    const [verificationGasLimit, callGasLimit] = this._unpackUint128x2(op.accountGasLimits);
    const [maxPriorityFeePerGas, maxFeePerGas] = this._unpackUint128x2(op.gasFees);
    const [paymaster, paymasterData] = this._unpackPaymaster(op.paymasterAndData);

    const result: Record<string, unknown> = {
      sender:                op.sender,
      nonce:                 op.nonce,
      callData:              op.callData,
      callGasLimit:          toHex(callGasLimit),
      verificationGasLimit:  toHex(verificationGasLimit),
      preVerificationGas:    op.preVerificationGas,
      maxFeePerGas:          toHex(maxFeePerGas),
      maxPriorityFeePerGas:  toHex(maxPriorityFeePerGas),
      signature:             op.signature,
    };

    // Only include paymaster fields if there's a paymaster
    if (paymaster && paymaster !== '0x0000000000000000000000000000000000000000') {
      result.paymaster                    = paymaster;
      result.paymasterData                = paymasterData;
      result.paymasterVerificationGasLimit = toHex(100_000n);
      result.paymasterPostOpGasLimit       = toHex(50_000n);
    }

    // Only include factory if initCode is non-empty
    if (op.initCode && op.initCode !== '0x') {
      result.factory     = ('0x' + op.initCode.slice(2, 42)) as Hex;
      result.factoryData = ('0x' + op.initCode.slice(42)) as Hex;
    }

    return result;
  }

  private _unpackUint128x2(packed: Hex): [bigint, bigint] {
    const n = hexToBigInt(packed);
    const high = n >> 128n;
    const low  = n & ((1n << 128n) - 1n);
    return [high, low];
  }

  private _unpackPaymaster(paymasterAndData: Hex): [string, Hex] {
    if (!paymasterAndData || paymasterAndData === '0x' || paymasterAndData.length < 42) {
      return ['0x0000000000000000000000000000000000000000', '0x'];
    }
    const paymaster    = '0x' + paymasterAndData.slice(2, 42);
    const paymasterData = ('0x' + paymasterAndData.slice(42)) as Hex;
    return [paymaster, paymasterData];
  }

  /**
   * Pack two uint128 values into a bytes32 (used for accountGasLimits and gasFees).
   * Layout: [high 16 bytes = a][low 16 bytes = b]
   */
  private _packUint128x2(a: bigint, b: bigint): Hex {
    return encodePacked(['uint128', 'uint128'], [a, b]);
  }

  private _padGas(estimate: bigint): bigint {
    return (estimate * GAS_OVERHEAD_FACTOR) / GAS_OVERHEAD_DENOM;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}