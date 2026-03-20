import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Router, Request, Response } from 'express';
import type { KeyStore } from '../../keystore/KeyStore.js';
import type { BundlerEip7702Auth } from '../../userop/UserOpBuilder.js';

export function registerKeystoreRoutes(router: Router, keyStore: KeyStore): void {

  // POST /api/register-key
  // Called by Dashboard after on-chain policy instance + EOA binding (see echo-contracts).
  // `accountAddress` is the user EOA (UserOp.sender); stores execute key for Gateway signing.
  router.post('/register-key', async (req: Request, res: Response) => {
    try {
      const { instanceId, accountAddress, ownerAddress, name, label } = req.body as {
        instanceId:     string;
        accountAddress: string;  // User EOA — UserOp.sender (swap recipient)
        ownerAddress?:  string;  // EOA wallet address (owner)
        name?:          string;  // user-defined account name e.g. "My DCA Bot"
        label?:         string;  // template name fallback
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

      // Label format: "name|account:0xEOA|owner:0xEOA"
      // Structured so we can parse each field back out
      const accountName = name || label || 'My Account';
      const storedLabel = [
        accountName,
        `account:${accountAddress}`,
        ownerAddress ? `owner:${ownerAddress}` : '',
      ].filter(Boolean).join('|');

      const { keyHash } = await keyStore.addKey(instanceId, 'execute', storedLabel);

      res.json({ ok: true, instanceId, keyHash, accountAddress, ownerAddress });
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
        // Parse structured label: "name|account:0xEOA|owner:0xEOA"
        accountAddress: meta.label.match(/account:(0x[0-9a-fA-F]{40})/)?.[1] ?? null,
        ownerAddress:   meta.label.match(/owner:(0x[0-9a-fA-F]{40})/)?.[1] ?? null,
        name:           meta.label.split('|')[0] ?? meta.label,
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

  // GET /api/context — returns the currently active account (set by Dashboard on wallet connect)
  router.get('/context', (_req: Request, res: Response) => {
    try {
      const keys = keyStore.listKeys('execute');
      if (!keys.length) { res.json({ active: null }); return; }
      // Return first key's context — in multi-account scenario this is the last-set active
      const active = keys[0]!;
      res.json({
        active: {
          instanceId:     active.id,
          accountAddress: active.label.match(/account:(0x[0-9a-fA-F]{40})/)?.[1] ?? null,
          ownerAddress:   active.label.match(/owner:(0x[0-9a-fA-F]{40})/)?.[1] ?? null,
          name:           active.label.split('|')[0] ?? active.label,
          keyHash:        active.keyHash,
        },
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/context — Dashboard calls this when user connects wallet and account loads
  router.post('/context', async (req: Request, res: Response) => {
    try {
      const { instanceId, eip7702Auth } = req.body as {
        instanceId: string;
        /** Pimlico `eip7702Auth` — signed EIP-7702 authorization (delegate = EchoDelegationModule). */
        eip7702Auth?: BundlerEip7702Auth;
      };
      if (!instanceId) { res.status(400).json({ error: 'instanceId required' }); return; }
      // Verify key exists
      const meta = keyStore.getKeyMeta(instanceId);
      if (!meta) { res.status(404).json({ error: 'instanceId not found in KeyStore' }); return; }
      // Store as active context in a simple file next to keystore
      const ctxPath = keyStore.path.replace('keystore.json', 'context.json');
      mkdirSync(dirname(ctxPath), { recursive: true });
      let prev: Record<string, unknown> = {};
      if (existsSync(ctxPath)) {
        try {
          prev = JSON.parse(readFileSync(ctxPath, 'utf8')) as Record<string, unknown>;
        } catch { /* ignore */ }
      }
      const next = {
        ...prev,
        activeInstanceId: instanceId,
        updatedAt:        Date.now(),
        ...(eip7702Auth !== undefined ? { eip7702Auth } : {}),
      };
      writeFileSync(ctxPath, JSON.stringify(next));
      res.json({ ok: true, instanceId });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // PATCH /api/keys/:instanceId — update ownerAddress and/or name on existing key
  // Used to migrate legacy accounts that don't have ownerAddress stored
  router.patch('/keys/:instanceId', async (req: Request, res: Response) => {
    try {
      const { instanceId } = req.params as { instanceId: string };
      const { ownerAddress, name } = req.body as { ownerAddress?: string; name?: string };

      const meta = keyStore.getKeyMeta(instanceId);
      if (!meta) {
        res.status(404).json({ error: `Key not found for instanceId=${instanceId}` });
        return;
      }

      // Parse existing label and rebuild with new fields
      // Old format: "account:0x... (standard)"  or "Name|account:0x...|owner:0xEOA"
      const existingLabel = meta.label;
      const accountAddrMatch = existingLabel.match(/account:(0x[0-9a-fA-F]{40})/);
      const accountAddr = accountAddrMatch?.[1] ?? '';
      const existingName = existingLabel.split('|')[0]?.replace(/account:0x.*/, '').trim() || 'My Account';

      const newName = name ?? existingName;
      const newOwner = ownerAddress ?? existingLabel.match(/owner:(0x[0-9a-fA-F]{40})/)?.[1] ?? '';
      const newLabel = [newName, `account:${accountAddr}`, newOwner ? `owner:${newOwner}` : '']
        .filter(Boolean).join('|');

      await keyStore.rotateLabel(instanceId, newLabel);
      res.json({ ok: true, instanceId, label: newLabel });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}