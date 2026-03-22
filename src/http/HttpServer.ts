/**
 * HttpServer — local HTTP server for the Echo Dashboard.
 *
 * Serves:
 *   /           → Dashboard HTML (index.html)
 *   /assets/*   → Static JS/CSS assets
 *   /api/*      → REST API for policy, sessions, keystore
 *
 * MCP transport: stdio only (managed by McpServer).
 * Binds to 127.0.0.1 only — never exposed to the network.
 */

import express, { type Request, type Response } from 'express';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import type { KeyStore } from '../keystore/KeyStore.js';
import type { GatewayConfig } from '../config/index.js';
import { registerPolicyRoutes }     from './routes/policy.js';
import { registerSessionRoutes }    from './routes/sessions.js';
import { registerKeystoreRoutes }   from './routes/keystore.js';
import { registerRpcProxyRoutes }   from './routes/rpcProxy.js';
import { registerSettingsRoutes }   from './routes/settings.js';
import { registerAuthRoutes }       from './routes/auth.js';
import { registerActivationRoutes } from './routes/activation.js';
import { ActivityLog }              from '../activity/ActivityLog.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export class HttpServer {
  private readonly app: express.Application;
  private readonly config: GatewayConfig;

  constructor(config: GatewayConfig, keyStore: KeyStore) {
    this.config = config;
    this.app    = express();

    this.app.use(express.json());

    // Serve static dashboard files
    const dashboardDir = join(__dirname, '..', 'dashboard');
    this.app.use('/assets', express.static(join(dashboardDir, 'assets')));

    // Dashboard SPA
    this.app.get('/', (_req: Request, res: Response) => {
      res.sendFile(join(dashboardDir, 'index.html'));
    });

    // API routes
    const api = express.Router();
    registerRpcProxyRoutes(api, config);
    registerPolicyRoutes(api, config);
    registerSessionRoutes(api, config, keyStore);
    registerKeystoreRoutes(api, keyStore);
    registerSettingsRoutes(api, config);
    registerActivationRoutes(api, config);
    if (config.privy) {
      registerAuthRoutes(api, config.privy.appId, config.privy.appSecret);
    }

    // Activity log endpoint
    const activityLog = new ActivityLog(config.keystorePath);
    api.get('/activity', (req: Request, res: Response) => {
      const instanceId = typeof req.query['instanceId'] === 'string' ? req.query['instanceId'] : undefined;
      res.json({ entries: activityLog.list(instanceId) });
    });

    this.app.use('/api', api);

    // Config endpoint — exposes non-sensitive config to Dashboard JS
    this.app.get('/api/config', (_req: Request, res: Response) => {
      res.json({
        chainId:        config.chainId,
        contracts:      config.contracts,
        templates:      config.templates,
        echoOnboarding: config.echoOnboarding,
        privyAppId:     config.privy?.appId ?? null,
      });
    });

    // MCP setup endpoint — provides local paths for the Dashboard MCP config UI
    this.app.get('/api/mcp-setup', (_req: Request, res: Response) => {
      try {
        const gatewayRoot = join(__dirname, '..', '..');
        const envFilePath = join(gatewayRoot, '.env');
        const distIndexPath = join(gatewayRoot, 'dist', 'index.js');
        res.json({
          envFilePath,
          envFileExists: existsSync(envFilePath),
          distIndexPath,
        });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer(this.app);
      server.on('error', reject);
      server.listen(this.config.port, '127.0.0.1', () => {
        console.error(`[Echo Gateway] Dashboard: http://127.0.0.1:${this.config.port}`);
        resolve();
      });
    });
  }
}
