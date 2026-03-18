import type { Router, Request, Response } from 'express';
import type { GatewayConfig } from '../../config/index.js';

export function registerRpcProxyRoutes(router: Router, config: GatewayConfig): void {
  // JSON-RPC proxy for browser usage.
  // Fixes CORS issues by keeping all calls same-origin (/api/rpc).

  router.options('/rpc', (_req: Request, res: Response) => {
    res.sendStatus(204);
  });

  router.post('/rpc', async (req: Request, res: Response) => {
    try {
      const payload = req.body;

      const upstream = await fetch(config.sepoliaRpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const text = await upstream.text();

      // Most JSON-RPC responses are JSON; forward raw body to keep behavior.
      res
        .status(upstream.status)
        .contentType(upstream.headers.get('content-type') ?? 'application/json')
        .send(text);
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

