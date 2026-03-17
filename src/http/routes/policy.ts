import type { Router, Request, Response } from 'express';
import { createPublicClient, http } from 'viem';
import { sepolia } from 'viem/chains';
import { POLICY_REGISTRY_ABI } from '../../contracts/PolicyRegistryABI.js';
import type { GatewayConfig } from '../../config/index.js';
import type { Address, Hex } from 'viem';

export function registerPolicyRoutes(router: Router, config: GatewayConfig): void {
  const client = createPublicClient({
    chain: sepolia,
    transport: http(config.sepoliaRpcUrl),
  });

  // GET /api/policy/:instanceId
  router.get('/policy/:instanceId', async (req: Request, res: Response) => {
    try {
      const instanceId = req.params['instanceId'] as Hex;

      const [inst, instFull] = await Promise.all([
        client.readContract({
          address:      config.contracts.policyRegistry,
          abi:          POLICY_REGISTRY_ABI,
          functionName: 'getInstanceValidation',
          args:         [instanceId],
        }),
        client.readContract({
          address:      config.contracts.policyRegistry,
          abi:          POLICY_REGISTRY_ABI,
          functionName: 'getInstance',
          args:         [instanceId],
        }),
      ]);

      const tokenLimits = await Promise.all(
        instFull.tokenList.map(async (token) => {
          const tl = await client.readContract({
            address:      config.contracts.policyRegistry,
            abi:          POLICY_REGISTRY_ABI,
            functionName: 'getTokenLimitValidation',
            args:         [instanceId, token as Address],
          });
          return {
            token,
            maxPerOp:   tl.maxPerOp.toString(),
            maxPerDay:  tl.maxPerDay.toString(),
            dailySpent: tl.dailySpent.toString(),
          };
        }),
      );

      res.json({
        instanceId,
        paused:            inst.paused,
        expiry:            Number(inst.expiry),
        globalTotalBudget: inst.globalTotalBudget.toString(),
        globalTotalSpent:  inst.globalTotalSpent.toString(),
        globalMaxPerDay:   inst.globalMaxPerDay.toString(),
        globalDailySpent:  inst.globalDailySpent.toString(),
        explorationBudget: inst.explorationBudget.toString(),
        explorationSpent:  inst.explorationSpent.toString(),
        allowedTargets:    instFull.allowedTargets,
        allowedSelectors:  instFull.allowedSelectors,
        tokenLimits,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/policy/pause — build pendingTx for user to sign
  router.post('/policy/pause', async (req: Request, res: Response) => {
    try {
      const { instanceId } = req.body as { instanceId: string };
      const { encodeFunctionData } = await import('viem');
      const { POLICY_REGISTRY_ABI } = await import('../../contracts/PolicyRegistryABI.js');

      const calldata = encodeFunctionData({
        abi: POLICY_REGISTRY_ABI,
        functionName: 'pauseInstance',
        args: [instanceId as `0x${string}`],
      });

      res.json({
        paused: true,
        instanceId,
        pendingTx: { to: config.contracts.policyRegistry, calldata, chainId: config.chainId },
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
