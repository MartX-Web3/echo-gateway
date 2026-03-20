import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Router, Request, Response } from 'express';
import type { KeyStore } from '../../keystore/KeyStore.js';
import type { BundlerEip7702Auth } from '../../userop/UserOpBuilder.js';

const PENDING_PREFIX = 'pending:' as const;

function isHexAddr(a: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(a);
}

function isBytes32(a: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(a);
}

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

  // POST /api/onboarding/prepare — create execute key under pending id + return keyHash for chain registration
  router.post('/onboarding/prepare', async (req: Request, res: Response) => {
    try {
      const { accountAddress, ownerAddress, name, label } = req.body as {
        accountAddress: string;
        ownerAddress?: string;
        name?:          string;
        label?:         string;
      };
      if (!accountAddress || !isHexAddr(accountAddress)) {
        res.status(400).json({ error: 'accountAddress (0x + 40 hex) is required' });
        return;
      }
      const pendingId = `${PENDING_PREFIX}${randomBytes(16).toString('hex')}`;
      const accountName = name || label || 'My Account';
      const storedLabel = [
        accountName,
        `account:${accountAddress}`,
        ownerAddress && isHexAddr(ownerAddress) ? `owner:${ownerAddress}` : '',
      ].filter(Boolean).join('|');

      const { keyHash } = await keyStore.addKey(pendingId, 'execute', storedLabel);
      res.json({ ok: true, pendingId, executeKeyHash: keyHash });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/onboarding/finalize — promote pending execute key to on-chain instanceId
  router.post('/onboarding/finalize', async (req: Request, res: Response) => {
    try {
      const { pendingId, instanceId, accountAddress, ownerAddress, name, label } = req.body as {
        pendingId:      string;
        instanceId:     string;
        accountAddress: string;
        ownerAddress?:  string;
        name?:          string;
        label?:         string;
      };
      if (!pendingId || !pendingId.startsWith(PENDING_PREFIX)) {
        res.status(400).json({ error: 'valid pendingId is required' });
        return;
      }
      if (!instanceId || !isBytes32(instanceId)) {
        res.status(400).json({ error: 'instanceId must be 0x + 64 hex' });
        return;
      }
      if (!accountAddress || !isHexAddr(accountAddress)) {
        res.status(400).json({ error: 'accountAddress (0x + 40 hex) is required' });
        return;
      }
      if (!keyStore.hasKey(pendingId)) {
        res.status(404).json({ error: 'pendingId not found — run prepare again' });
        return;
      }
      if (keyStore.hasKey(instanceId)) {
        res.status(409).json({
          error:
            `Key already exists for instanceId=${instanceId}. ` +
            'Usually the wizard still had an old instanceId after a new "Prepare" (new execute key) without a new Step 3 tx — open Onboarding again to reset, then run Prepare → Step 3 → Finish in one pass. ' +
            'Or remove the existing execute key for this instance from the Gateway keystore if you intend to replace it.',
        });
        return;
      }

      const accountName = name || label || 'My Account';
      const storedLabel = [
        accountName,
        `account:${accountAddress}`,
        ownerAddress && isHexAddr(ownerAddress) ? `owner:${ownerAddress}` : '',
      ].filter(Boolean).join('|');

      await keyStore.renameKeyId(pendingId, instanceId);
      await keyStore.rotateLabel(instanceId, storedLabel);

      const meta = keyStore.getKeyMeta(instanceId);
      res.json({ ok: true, instanceId, keyHash: meta?.keyHash, accountAddress, ownerAddress });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // DELETE /api/onboarding/pending/:pendingId — drop an unused pending key
  router.delete('/onboarding/pending/:pendingId', async (req: Request, res: Response) => {
    try {
      const { pendingId } = req.params as { pendingId: string };
      const id = decodeURIComponent(pendingId);
      if (!id.startsWith(PENDING_PREFIX)) {
        res.status(400).json({ error: 'invalid pending id' });
        return;
      }
      if (!keyStore.hasKey(id)) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      await keyStore.deleteKey(id);
      res.json({ ok: true, pendingId: id });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/keys — list registered instances (no raw keys exposed)
  router.get('/keys', (_req: Request, res: Response) => {
    try {
      const keys = keyStore.listKeys('execute').filter(meta => !meta.id.startsWith(PENDING_PREFIX)).map(meta => ({
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