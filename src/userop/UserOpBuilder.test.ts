/**
 * UserOpBuilder unit tests.
 * All network calls are mocked — no real RPC or Pimlico calls.
 *
 * Covers:
 *   - _buildOuterCalldata: correct ABI layout for EchoPolicyValidator
 *   - _getNonce: reads from EntryPoint correctly
 *   - submit: assembles the correct UserOp and submits via Pimlico
 *   - Paymaster: paymasterAndData is populated from pm_sponsorUserOperation
 *   - Polling: retries until receipt is found, throws after max attempts
 *   - Error handling: Pimlico RPC errors surfaced correctly
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { decodeFunctionData, hexToBigInt } from 'viem';
import { UserOpBuilder } from './UserOpBuilder.js';

// ── Mock viem public client ────────────────────────────────────────────────

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    createPublicClient: vi.fn(),
  };
});

import { createPublicClient } from 'viem';

function setupPublicClientMock(): ReturnType<typeof vi.fn> {
  const readContract = vi.fn();
  (createPublicClient as ReturnType<typeof vi.fn>).mockReturnValueOnce({ readContract });
  return readContract;
}

// ── Mock fetch ─────────────────────────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function mockRpc(result: unknown) {
  mockFetch.mockResolvedValueOnce({
    ok:   true,
    json: async () => ({ jsonrpc: '2.0', id: 1, result }),
  });
}

function mockRpcError(code: number, message: string) {
  mockFetch.mockResolvedValueOnce({
    ok:   true,
    json: async () => ({ jsonrpc: '2.0', id: 1, error: { code, message } }),
  });
}

// ── Constants ──────────────────────────────────────────────────────────────

const ACCOUNT    = '0x1234567890123456789012345678901234567890' as const;
const TARGET     = '0x2e49DaB78491F0C82636401a59602661cdA51Bb5' as const;
const INNER_CD   = '0x414bf389' + 'ab'.repeat(228) as `0x${string}`; // fake exactInputSingle calldata
const SIGNATURE  = ('0x01' + 'ab'.repeat(32)) as `0x${string}`;

const SPONSOR_RESPONSE = {
  paymaster:                      '0x' + '11'.repeat(20),
  paymasterVerificationGasLimit: '0x186a0',
  paymasterPostOpGasLimit:       '0x186a0',
  paymasterData:                  '0x' + '22'.repeat(32),
  preVerificationGas:             '0x5208',
  verificationGasLimit:          '0x186a0',
  callGasLimit:                  '0x186a0',
};

const GAS_PRICE_RESPONSE = {
  slow:     { maxFeePerGas: '0x1', maxPriorityFeePerGas: '0x1' },
  standard: { maxFeePerGas: '0x1', maxPriorityFeePerGas: '0x1' },
  fast:     { maxFeePerGas: '0x77359400', maxPriorityFeePerGas: '0x3b9aca00' },
};

const USER_OP_HASH = ('0x' + 'ef'.repeat(32)) as `0x${string}`;
const TX_HASH      = ('0x' + 'aa'.repeat(32)) as `0x${string}`;

function makeBuilder() {
  return new UserOpBuilder({
    rpcUrl:     'https://rpc.example.com',
    pimlicoUrl: 'https://api.pimlico.io/v2/sepolia/rpc?apikey=test',
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('UserOpBuilder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Outer calldata construction ────────────────────────────────────────

  describe('_buildOuterCalldata (via submit)', () => {
    it('wraps innerCalldata in AccountERC7579.execute()', async () => {
      const readContract = setupPublicClientMock();
      readContract.mockResolvedValueOnce(0n); // nonce = 0

      mockRpc(GAS_PRICE_RESPONSE); // pimlico_getUserOperationGasPrice
      mockRpc(SPONSOR_RESPONSE);   // pm_sponsorUserOperation
      mockRpc(USER_OP_HASH);       // eth_sendUserOperation
      mockRpc({ receipt: { transactionHash: TX_HASH } }); // receipt

      const builder = makeBuilder();
      await builder.submit(ACCOUNT, TARGET, INNER_CD, SIGNATURE);

      // Inspect the callData sent to Pimlico
      const sponsorCall = JSON.parse(mockFetch.mock.calls[1]![1]!.body as string);
      const userOp = sponsorCall.params[0] as { callData: string };
      const outerCalldata = userOp.callData as `0x${string}`;

      // Must decode as execute(bytes32, bytes)
      const decoded = decodeFunctionData({
        abi: [{
          name: 'execute', type: 'function', stateMutability: 'payable',
          inputs: [{ name: 'mode', type: 'bytes32' }, { name: 'executionCalldata', type: 'bytes' }],
          outputs: [],
        }],
        data: outerCalldata,
      });

      expect(decoded.functionName).toBe('execute');
      const [mode, execData] = decoded.args as [`0x${string}`, `0x${string}`];
      expect(mode).toBe('0x' + '00'.repeat(32)); // CALLTYPE_SINGLE
      // executionCalldata starts with target address (20 bytes)
      expect(execData.toLowerCase()).toContain(TARGET.slice(2).toLowerCase());
    });

    it('target address is at bytes [100:120] of outer calldata', async () => {
      const readContract = setupPublicClientMock();
      readContract.mockResolvedValueOnce(0n);

      mockRpc(GAS_PRICE_RESPONSE);
      mockRpc(SPONSOR_RESPONSE);
      mockRpc(USER_OP_HASH);
      mockRpc({ receipt: { transactionHash: TX_HASH } });

      const builder = makeBuilder();
      await builder.submit(ACCOUNT, TARGET, INNER_CD, SIGNATURE);

      const sponsorCall = JSON.parse(mockFetch.mock.calls[1]![1]!.body as string);
      const callData = sponsorCall.params[0].callData as string;
      const callDataBuf = Buffer.from(callData.slice(2), 'hex');

      // Per EchoPolicyValidator: target is at [100:120]
      const targetFromCalldata = '0x' + callDataBuf.slice(100, 120).toString('hex');
      expect(targetFromCalldata.toLowerCase()).toBe(TARGET.toLowerCase());
    });

    it('value is 0 at bytes [120:152]', async () => {
      const readContract = setupPublicClientMock();
      readContract.mockResolvedValueOnce(0n);

      mockRpc(GAS_PRICE_RESPONSE);
      mockRpc(SPONSOR_RESPONSE);
      mockRpc(USER_OP_HASH);
      mockRpc({ receipt: { transactionHash: TX_HASH } });

      const builder = makeBuilder();
      await builder.submit(ACCOUNT, TARGET, INNER_CD, SIGNATURE);

      const sponsorCall = JSON.parse(mockFetch.mock.calls[1]![1]!.body as string);
      const callData = sponsorCall.params[0].callData as string;
      const callDataBuf = Buffer.from(callData.slice(2), 'hex');

      const valueSlice = callDataBuf.slice(120, 152);
      const value = BigInt('0x' + valueSlice.toString('hex'));
      expect(value).toBe(0n);
    });

    it('innerCalldata starts at byte 152', async () => {
      const readContract = setupPublicClientMock();
      readContract.mockResolvedValueOnce(0n);

      mockRpc(GAS_PRICE_RESPONSE);
      mockRpc(SPONSOR_RESPONSE);
      mockRpc(USER_OP_HASH);
      mockRpc({ receipt: { transactionHash: TX_HASH } });

      const builder = makeBuilder();
      await builder.submit(ACCOUNT, TARGET, INNER_CD, SIGNATURE);

      const sponsorCall = JSON.parse(mockFetch.mock.calls[1]![1]!.body as string);
      const callData = sponsorCall.params[0].callData as string;
      const callDataBuf = Buffer.from(callData.slice(2), 'hex');

      // First 4 bytes of innerCalldata = exactInputSingle selector = 0x414bf389
      const innerStart = callDataBuf.slice(152, 156);
      expect(innerStart.toString('hex')).toBe('414bf389');
    });
  });

  // ── Nonce ──────────────────────────────────────────────────────────────

  describe('nonce', () => {
    it('reads nonce from EntryPoint and passes it in UserOp', async () => {
      const readContract = setupPublicClientMock();
      readContract.mockResolvedValueOnce(7n); // nonce = 7

      mockRpc(GAS_PRICE_RESPONSE);
      mockRpc(SPONSOR_RESPONSE);
      mockRpc(USER_OP_HASH);
      mockRpc({ receipt: { transactionHash: TX_HASH } });

      const builder = makeBuilder();
      await builder.submit(ACCOUNT, TARGET, INNER_CD, SIGNATURE);

      const sponsorCall = JSON.parse(mockFetch.mock.calls[1]![1]!.body as string);
      const nonce = sponsorCall.params[0].nonce as string;
      expect(hexToBigInt(nonce as `0x${string}`)).toBe(7n);
    });
  });

  // ── Paymaster ──────────────────────────────────────────────────────────

  describe('paymaster', () => {
    it('calls pm_sponsorUserOperation with correct EntryPoint', async () => {
      const readContract = setupPublicClientMock();
      readContract.mockResolvedValueOnce(0n);

      mockRpc(GAS_PRICE_RESPONSE);
      mockRpc(SPONSOR_RESPONSE);
      mockRpc(USER_OP_HASH);
      mockRpc({ receipt: { transactionHash: TX_HASH } });

      const builder = makeBuilder();
      await builder.submit(ACCOUNT, TARGET, INNER_CD, SIGNATURE);

      const sponsorCall = JSON.parse(mockFetch.mock.calls[1]![1]!.body as string);
      expect(sponsorCall.method).toBe('pm_sponsorUserOperation');
      expect(sponsorCall.params[1]).toBe('0x0000000071727De22E5E9d8BAf0edAc6f37da032');
    });

    it('paymaster fields from sponsor response are in the submitted UserOp', async () => {
      const readContract = setupPublicClientMock();
      readContract.mockResolvedValueOnce(0n);

      mockRpc(GAS_PRICE_RESPONSE);
      mockRpc(SPONSOR_RESPONSE);
      mockRpc(USER_OP_HASH);
      mockRpc({ receipt: { transactionHash: TX_HASH } });

      const builder = makeBuilder();
      await builder.submit(ACCOUNT, TARGET, INNER_CD, SIGNATURE);

      const sendCall = JSON.parse(mockFetch.mock.calls[2]![1]!.body as string);
      expect(sendCall.method).toBe('eth_sendUserOperation');
      expect(sendCall.params[0].paymaster).toBe(SPONSOR_RESPONSE.paymaster);
      expect(sendCall.params[0].paymasterData).toBe(SPONSOR_RESPONSE.paymasterData);
      expect(sendCall.params[0].paymasterVerificationGasLimit).toBe(
        SPONSOR_RESPONSE.paymasterVerificationGasLimit,
      );
      expect(sendCall.params[0].paymasterPostOpGasLimit).toBe(
        SPONSOR_RESPONSE.paymasterPostOpGasLimit,
      );
    });

    it('gas limits are padded by 20%', async () => {
      const readContract = setupPublicClientMock();
      readContract.mockResolvedValueOnce(0n);

      mockRpc(GAS_PRICE_RESPONSE);
      mockRpc(SPONSOR_RESPONSE);
      mockRpc(USER_OP_HASH);
      mockRpc({ receipt: { transactionHash: TX_HASH } });

      const builder = makeBuilder();
      await builder.submit(ACCOUNT, TARGET, INNER_CD, SIGNATURE);

      const sendCall = JSON.parse(mockFetch.mock.calls[2]![1]!.body as string);

      const rawVer  = hexToBigInt(SPONSOR_RESPONSE.verificationGasLimit as `0x${string}`);
      const rawCall = hexToBigInt(SPONSOR_RESPONSE.callGasLimit as `0x${string}`);

      // 20% padding: padded = raw * 120 / 100
      const expectedVer = (rawVer * 120n) / 100n;
      const expectedCall = (rawCall * 120n) / 100n;

      const sentVer = hexToBigInt(sendCall.params[0].verificationGasLimit as `0x${string}`);
      const sentCall = hexToBigInt(sendCall.params[0].callGasLimit as `0x${string}`);
      expect(sentVer).toBe(expectedVer);
      expect(sentCall).toBe(expectedCall);
    });
  });

  // ── Signature ──────────────────────────────────────────────────────────

  describe('signature', () => {
    it('final UserOp contains the provided Echo signature', async () => {
      const readContract = setupPublicClientMock();
      readContract.mockResolvedValueOnce(0n);

      mockRpc(GAS_PRICE_RESPONSE);
      mockRpc(SPONSOR_RESPONSE);
      mockRpc(USER_OP_HASH);
      mockRpc({ receipt: { transactionHash: TX_HASH } });

      const builder = makeBuilder();
      await builder.submit(ACCOUNT, TARGET, INNER_CD, SIGNATURE);

      const sendCall = JSON.parse(mockFetch.mock.calls[2]![1]!.body as string);
      expect(sendCall.params[0].signature).toBe(SIGNATURE);
    });

    it('sponsor step uses dummy signature (not the real key)', async () => {
      const readContract = setupPublicClientMock();
      readContract.mockResolvedValueOnce(0n);

      mockRpc(GAS_PRICE_RESPONSE);
      mockRpc(SPONSOR_RESPONSE);
      mockRpc(USER_OP_HASH);
      mockRpc({ receipt: { transactionHash: TX_HASH } });

      const builder = makeBuilder();
      await builder.submit(ACCOUNT, TARGET, INNER_CD, SIGNATURE);

      // Sponsor call (first fetch) should use dummy sig, NOT the real signature
      const sponsorCall = JSON.parse(mockFetch.mock.calls[1]![1]!.body as string);
      expect(sponsorCall.params[0].signature).not.toBe(SIGNATURE);
      // Dummy is 65 zero bytes
      expect(sponsorCall.params[0].signature).toBe('0x' + '00'.repeat(65));
    });
  });

  // ── Submission result ──────────────────────────────────────────────────

  describe('submit result', () => {
    it('returns userOpHash and txHash', async () => {
      const readContract = setupPublicClientMock();
      readContract.mockResolvedValueOnce(0n);

      mockRpc(GAS_PRICE_RESPONSE);
      mockRpc(SPONSOR_RESPONSE);
      mockRpc(USER_OP_HASH);
      mockRpc({ receipt: { transactionHash: TX_HASH } });

      const builder = makeBuilder();
      const result = await builder.submit(ACCOUNT, TARGET, INNER_CD, SIGNATURE);

      expect(result.userOpHash).toBe(USER_OP_HASH);
      expect(result.txHash).toBe(TX_HASH);
    });
  });

  // ── Polling ────────────────────────────────────────────────────────────

  describe('receipt polling', () => {
    it('retries when receipt is null and succeeds on second attempt', async () => {
      // Speed up polling for tests
      vi.useFakeTimers();

      const readContract = setupPublicClientMock();
      readContract.mockResolvedValueOnce(0n);

      mockRpc(GAS_PRICE_RESPONSE);
      mockRpc(SPONSOR_RESPONSE);
      mockRpc(USER_OP_HASH);
      mockRpc(null);  // first poll: not yet included
      mockRpc({ receipt: { transactionHash: TX_HASH } }); // second poll: included

      const builder = makeBuilder();
      const promise = builder.submit(ACCOUNT, TARGET, INNER_CD, SIGNATURE);

      // Advance timers past both poll delays
      await vi.advanceTimersByTimeAsync(2_000);  // first poll
      await vi.advanceTimersByTimeAsync(3_000);  // second poll (2000 * 1.5)

      const result = await promise;
      expect(result.txHash).toBe(TX_HASH);

      vi.useRealTimers();
    });

    it('throws after max attempts', async () => {
      vi.useFakeTimers();

      const readContract = setupPublicClientMock();
      readContract.mockResolvedValueOnce(0n);

      mockRpc(GAS_PRICE_RESPONSE);
      mockRpc(SPONSOR_RESPONSE);
      mockRpc(USER_OP_HASH);

      // All polling attempts return null
      for (let i = 0; i < 10; i++) {
        mockRpc(null);
      }

      const builder = makeBuilder();

      // Attach rejection handler immediately to prevent unhandled rejection
      const promise = builder.submit(ACCOUNT, TARGET, INNER_CD, SIGNATURE);
      promise.catch(() => {}); // suppress unhandled rejection warning

      // Advance through all polling delays
      for (let i = 0; i < 10; i++) {
        await vi.advanceTimersByTimeAsync(60_000);
      }

      await expect(promise).rejects.toThrow('not included after');
      vi.useRealTimers();
    });
  });

  // ── Error handling ─────────────────────────────────────────────────────

  describe('error handling', () => {
    it('surfaces Pimlico RPC errors', async () => {
      const readContract = setupPublicClientMock();
      readContract.mockResolvedValueOnce(0n);

      mockRpcError(-32500, 'AA23 reverted: EchoPolicyValidator rejected');

      const builder = makeBuilder();
      await expect(
        builder.submit(ACCOUNT, TARGET, INNER_CD, SIGNATURE)
      ).rejects.toThrow('AA23 reverted');
    });

    it('surfaces HTTP errors', async () => {
      const readContract = setupPublicClientMock();
      readContract.mockResolvedValueOnce(0n);

      mockFetch.mockResolvedValueOnce({
        ok:   false,
        status: 503,
        text: async () => 'Service Unavailable',
      });

      const builder = makeBuilder();
      await expect(
        builder.submit(ACCOUNT, TARGET, INNER_CD, SIGNATURE)
      ).rejects.toThrow('HTTP 503');
    });
  });
});