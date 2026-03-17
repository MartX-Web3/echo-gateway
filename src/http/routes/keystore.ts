import type { Router, Request, Response } from 'express';
import type { KeyStore } from '../../keystore/KeyStore.js';

export function registerKeystoreRoutes(router: Router, keyStore: KeyStore): void {

  // POST /api/register-key
  // Called by Dashboard after EchoAccountFactory.createAccount() is confirmed on-chain.
  // Stores the execute key in KeyStore so Gateway can sign UserOps.
  router.post('/register-key', async (req: Request, res: Response) => {
    try {
      const { instanceId, accountAddress, label } = req.body as {
        instanceId:     string;
        accountAddress: string;
        label?:         string;
      };

      if (!instanceId || !accountAddress) {
        res.status(400).json({ error: 'instanceId and accountAddress are required' });
        return;
      }

      // Check if key already exists
      if (keyStore.hasKey(instanceId)) {
        res.status(409).json({ error: `Key already exists for instanceId=${instanceId}` });
        return;
      }

      // Generate key — label encodes the account address for _getAccountAddress()
      const { keyHash } = await keyStore.addKey(
        instanceId,
        'execute',
        `account:${accountAddress}${label ? ` (${label})` : ''}`,
      );

      res.json({ ok: true, instanceId, keyHash, accountAddress });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/keys — list registered instances (no raw keys exposed)
  router.get('/keys', (_req: Request, res: Response) => {
    try {
      const keys = keyStore.listKeys('execute').map(meta => ({
        instanceId:     meta.id,
        keyHash:        meta.keyHash,
        label:          meta.label,
        createdAt:      meta.createdAt,
        expiresAt:      meta.expiresAt,
        // Extract account address from label
        accountAddress: meta.label.match(/account:(0x[0-9a-fA-F]{40})/)?.[1] ?? null,
      }));
      res.json({ keys });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // DELETE /api/keys/:instanceId
  router.delete('/keys/:instanceId', async (req: Request, res: Response) => {
    try {
      const { instanceId } = req.params as { instanceId: string };
      await keyStore.deleteKey(instanceId);
      res.json({ ok: true, instanceId });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
