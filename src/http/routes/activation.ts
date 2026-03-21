/**
 * Activation route — POST /api/activate-delegation
 *
 * Accepts the user's EOA private key, signs the EIP-7702 authorization tuple,
 * and sends a type-4 transaction that permanently sets delegation code on the EOA.
 *
 * This is the fallback path for wallets (OKX, Rabby) that silently downgrade
 * type-4 txs to type-2 and drop the authorizationList.
 *
 * Security notes:
 *  - Only bind on localhost (127.0.0.1) — never expose externally.
 *  - Private key is cleared from req.body immediately after use.
 *  - Any private key that leaks into an error string is redacted before responding.
 *  - Intended for development / testnet only.
 */

import { privateKeyToAccount }      from 'viem/accounts';
import { createWalletClient, http } from 'viem';
import { sepolia }                  from 'viem/chains';
import type { Router, Request, Response } from 'express';
import type { GatewayConfig }       from '../../config/index.js';

const PK_RE = /^0x[0-9a-fA-F]{64}$/;

/** Redact any 32-byte hex strings from error messages so private keys can't leak. */
function redact(msg: string): string {
  return msg.replace(/0x[0-9a-fA-F]{64}/gi, '[redacted]');
}

export function registerActivationRoutes(router: Router, config: GatewayConfig): void {

  /**
   * POST /api/activate-delegation
   *
   * Body: { privateKey: "0x<64 hex>" }
   *
   * Returns: { ok: true, txHash: "0x...", eoa: "0x..." }
   *
   * Pipeline:
   *   1. Derive account from private key (viem privateKeyToAccount)
   *   2. signAuthorization({ contractAddress: EchoDelegationModule })
   *      → produces { chainId, address, nonce, r, s, yParity }
   *   3. sendTransaction({ to: eoa, value: 0, data: '0x', authorizationList })
   *      → viem sets type: 0x4 automatically
   *   4. Return txHash — caller polls for receipt
   */
  router.post('/activate-delegation', async (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown>;
    const pk   = body.privateKey as string | undefined;

    // Clear from memory ASAP regardless of outcome
    body.privateKey = undefined;

    try {
      if (typeof pk !== 'string' || !PK_RE.test(pk)) {
        res.status(400).json({ error: 'privateKey must be 0x + 64 hex chars (32 bytes)' });
        return;
      }

      const account = privateKeyToAccount(pk as `0x${string}`);

      const walletClient = createWalletClient({
        account,
        chain:     sepolia,
        transport: http(config.sepoliaRpcUrl),
      });

      // Sign EIP-7702 authorization tuple (binds EchoDelegationModule as delegate).
      //
      // executor: 'self' is required when the EOA sends its OWN type-4 tx.
      // The tx increments the EOA nonce (N → N+1) BEFORE EIP-7702 auth processing,
      // so the auth tuple nonce must be N+1. Without this, auth.nonce = N but the
      // check sees N+1 → mismatch → delegation silently skipped → code stays 0x.
      const authorization = await walletClient.signAuthorization({
        contractAddress: config.contracts.echoDelegationModule,
        executor: 'self',
      });

      // Send type-4 tx — self-send to activate delegation on this EOA
      const txHash = await walletClient.sendTransaction({
        to:                account.address,
        value:             0n,
        data:              '0x',
        authorizationList: [authorization],
      });

      res.json({ ok: true, txHash, eoa: account.address });

    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: redact(raw) });
    }
  });
}
