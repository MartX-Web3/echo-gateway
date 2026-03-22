import type { Router, Request, Response } from 'express';
import { createPublicClient, http } from 'viem';
import { sepolia } from 'viem/chains';
import { POLICY_REGISTRY_ABI } from '../../contracts/PolicyRegistryABI.js';
import type { GatewayConfig } from '../../config/index.js';
import type { KeyStore } from '../../keystore/KeyStore.js';
import type { Hex } from 'viem';

export function registerSessionRoutes(router: Router, config: GatewayConfig, keyStore: KeyStore): void {
  const client = createPublicClient({
    chain: sepolia,
    transport: http(config.sepoliaRpcUrl),
  });

  // GET /api/sessions?instanceId=... — list all sessions (from keystore + on-chain)
  router.get('/sessions', async (req: Request, res: Response) => {
    try {
      const filterInstanceId = typeof req.query['instanceId'] === 'string'
        ? req.query['instanceId'].toLowerCase()
        : undefined;

      const sessionKeys = keyStore.listKeys('session');

      const sessions = await Promise.all(
        sessionKeys.map(async (k) => {
          try {
            // Use the confirmed on-chain sessionId if available; fall back to keyHash
            const sessionId = (k.meta?.['onChainSessionId'] ?? k.keyHash) as Hex;
            const sess = await client.readContract({
              address:      config.contracts.policyRegistry,
              abi:          POLICY_REGISTRY_ABI,
              functionName: 'getSessionValidation',
              args:         [sessionId],
            });
            return {
              sessionId,
              label:          k.label,
              createdAt:      k.createdAt,
              instanceId:     sess.instanceId,
              tokenIn:        sess.tokenIn,
              tokenOut:       sess.tokenOut,
              maxAmountPerOp: sess.maxAmountPerOp.toString(),
              totalBudget:    sess.totalBudget.toString(),
              totalSpent:     sess.totalSpent.toString(),
              maxOpsPerDay:   Number(sess.maxOpsPerDay),
              dailyOps:       Number(sess.dailyOps),
              sessionExpiry:  Number(sess.sessionExpiry),
              active:         sess.active,
              status:         'active' as const,
            };
          } catch {
            // Not yet on-chain — show as pending
            return {
              sessionId:      k.keyHash as Hex,
              label:          k.label,
              createdAt:      k.createdAt,
              instanceId:     k.meta?.['instanceId'] ?? null,
              tokenIn:        null,
              tokenOut:       null,
              maxAmountPerOp: null,
              totalBudget:    null,
              totalSpent:     null,
              maxOpsPerDay:   null,
              dailyOps:       null,
              sessionExpiry:  k.expiresAt ? Math.floor(k.expiresAt / 1000) : null,
              active:         false,
              status:         'pending' as const,
              pendingTx:      k.meta?.['calldata'] ? {
                to:       k.meta['to'] ?? '',
                calldata: k.meta['calldata'],
                chainId:  config.chainId,
              } : null,
            };
          }
        }),
      );

      const result = sessions
        .filter((s): s is NonNullable<typeof s> => s !== null)
        .filter(s => !filterInstanceId || s.instanceId === null || s.instanceId.toLowerCase() === filterInstanceId);

      res.json({ sessions: result });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/sessions/:sessionId — get single session
  router.get('/sessions/:sessionId', async (req: Request, res: Response) => {
    try {
      const sessionId = req.params['sessionId'] as Hex;

      const sess = await client.readContract({
        address:      config.contracts.policyRegistry,
        abi:          POLICY_REGISTRY_ABI,
        functionName: 'getSessionValidation',
        args:         [sessionId],
      });

      res.json({
        sessionId,
        instanceId:     sess.instanceId,
        tokenIn:        sess.tokenIn,
        tokenOut:       sess.tokenOut,
        maxAmountPerOp: sess.maxAmountPerOp.toString(),
        totalBudget:    sess.totalBudget.toString(),
        totalSpent:     sess.totalSpent.toString(),
        maxOpsPerDay:   Number(sess.maxOpsPerDay),
        dailyOps:       Number(sess.dailyOps),
        sessionExpiry:  Number(sess.sessionExpiry),
        active:         sess.active,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/sessions/create — build pendingTx for user to sign
  router.post('/sessions/create', async (req: Request, res: Response) => {
    try {
      const { instanceId, tokenIn, tokenOut, maxAmountPerOp, totalBudget, maxOpsPerDay, sessionExpiry } = req.body;
      const { encodeFunctionData } = await import('viem');
      const { POLICY_REGISTRY_ABI } = await import('../../contracts/PolicyRegistryABI.js');

      const calldata = encodeFunctionData({
        abi: POLICY_REGISTRY_ABI,
        functionName: 'createSession',
        args: [instanceId as `0x${string}`, ('0x' + '00'.repeat(32)) as `0x${string}`, tokenIn as `0x${string}`, tokenOut as `0x${string}`,
          BigInt(maxAmountPerOp), BigInt(totalBudget), BigInt(maxOpsPerDay), BigInt(sessionExpiry)],
      });

      res.json({
        pendingTx: { to: config.contracts.policyRegistry, calldata, chainId: config.chainId },
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/sessions/resolve-tx — fetch receipt, parse SessionCreated event, store real sessionId
  router.post('/sessions/resolve-tx', async (req: Request, res: Response) => {
    try {
      const { keyHash, txHash } = req.body as { keyHash: string; txHash: string };
      const { keccak256, toBytes } = await import('viem');
      const topic0 = keccak256(toBytes('SessionCreated(bytes32,bytes32,address)'));

      const receipt = await client.getTransactionReceipt({ hash: txHash as `0x${string}` });
      const log = receipt.logs.find(l => l.topics[0]?.toLowerCase() === topic0.toLowerCase());
      if (!log || !log.topics[1]) {
        res.status(400).json({ error: 'SessionCreated event not found in tx receipt. The transaction may have failed or used a different session.' });
        return;
      }
      const onChainSessionId = log.topics[1];

      const { readFileSync, writeFileSync } = await import('node:fs');
      const ks = JSON.parse(readFileSync(keyStore.path, 'utf8'));
      const entry = ks.keys.find((k: { keyHash: string }) => k.keyHash === keyHash);
      if (!entry) { res.status(404).json({ error: 'Session key not found' }); return; }
      entry.id   = onChainSessionId;
      entry.meta = { ...(entry.meta ?? {}), onChainSessionId };
      writeFileSync(keyStore.path, JSON.stringify(ks, null, 2));
      res.json({ ok: true, onChainSessionId });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/sessions/confirm — store the real on-chain sessionId after tx confirms
  router.post('/sessions/confirm', (req: Request, res: Response) => {
    try {
      const { keyHash, onChainSessionId } = req.body as { keyHash: string; onChainSessionId: string };
      const { readFileSync, writeFileSync } = require('node:fs');
      const ks = JSON.parse(readFileSync(keyStore.path, 'utf8'));
      const entry = ks.keys.find((k: { keyHash: string }) => k.keyHash === keyHash);
      if (!entry) { res.status(404).json({ error: 'Session key not found' }); return; }
      // Update id to real sessionId so getKey(sessionId) works for buildSessionSig
      entry.id   = onChainSessionId;
      entry.meta = { ...(entry.meta ?? {}), onChainSessionId };
      writeFileSync(keyStore.path, JSON.stringify(ks, null, 2));
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/sessions/revoke — build pendingTx for user to sign
  router.post('/sessions/revoke', async (req: Request, res: Response) => {
    try {
      const { sessionId } = req.body as { sessionId: string };
      const { encodeFunctionData } = await import('viem');
      const { POLICY_REGISTRY_ABI } = await import('../../contracts/PolicyRegistryABI.js');

      const calldata = encodeFunctionData({
        abi: POLICY_REGISTRY_ABI,
        functionName: 'revokeSession',
        args: [sessionId as `0x${string}`],
      });

      res.json({
        revoked: true,
        sessionId,
        pendingTx: { to: config.contracts.policyRegistry, calldata, chainId: config.chainId },
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
