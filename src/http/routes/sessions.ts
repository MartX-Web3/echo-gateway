import type { Router, Request, Response } from 'express';
import { createPublicClient, http } from 'viem';
import { sepolia } from 'viem/chains';
import { POLICY_REGISTRY_ABI } from '../../contracts/PolicyRegistryABI.js';
import type { GatewayConfig } from '../../config/index.js';
import type { Hex } from 'viem';

export function registerSessionRoutes(router: Router, config: GatewayConfig): void {
  const client = createPublicClient({
    chain: sepolia,
    transport: http(config.sepoliaRpcUrl),
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
