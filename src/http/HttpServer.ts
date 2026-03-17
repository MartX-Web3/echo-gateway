/**
 * HttpServer — local HTTP server for the Echo Dashboard.
 *
 * Serves:
 *   /           → Dashboard HTML (index.html)
 *   /sessions   → Sessions page (sessions.html)
 *   /assets/*   → Static JS/CSS assets
 *   /api/*      → REST API for policy, sessions, keystore
 *
 * Binds to 127.0.0.1 only — never exposed to the network.
 */

import express, { type Request, type Response } from 'express';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { KeyStore } from '../keystore/KeyStore.js';
import type { GatewayConfig } from '../config/index.js';
import { registerPolicyRoutes }   from './routes/policy.js';
import { registerSessionRoutes }  from './routes/sessions.js';
import { registerKeystoreRoutes } from './routes/keystore.js';

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

    // Dashboard pages
    this.app.get('/', (_req: Request, res: Response) => {
      res.sendFile(join(dashboardDir, 'index.html'));
    });
    this.app.get('/sessions', (_req: Request, res: Response) => {
      res.sendFile(join(dashboardDir, 'sessions.html'));
    });

    // API routes
    const api = express.Router();
    registerPolicyRoutes(api, config);
    registerSessionRoutes(api, config);
    registerKeystoreRoutes(api, keyStore);
    this.app.use('/api', api);

    // Config endpoint — exposes non-sensitive config to Dashboard JS
    this.app.get('/api/config', (_req: Request, res: Response) => {
      res.json({
        chainId:    config.chainId,
        contracts:  config.contracts,
        templates:  config.templates,
      });
    });
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      const server = createServer(this.app);
      server.listen(this.config.port, '127.0.0.1', () => {
        console.error(`[Echo Gateway] Dashboard: http://127.0.0.1:${this.config.port}`);
        resolve();
      });
    });
  }
}
