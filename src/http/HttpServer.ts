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
import { existsSync } from 'node:fs';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import type { KeyStore } from '../keystore/KeyStore.js';
import type { GatewayConfig } from '../config/index.js';
import type { McpServer } from '../mcp/McpServer.js';
import { registerPolicyRoutes }   from './routes/policy.js';
import { registerSessionRoutes }  from './routes/sessions.js';
import { registerKeystoreRoutes } from './routes/keystore.js';
import { registerRpcProxyRoutes } from './routes/rpcProxy.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerAuthRoutes }     from './routes/auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export class HttpServer {
  private readonly app: express.Application;
  private readonly config: GatewayConfig;
  private mcpServer: McpServer | null = null;
  // One SSE transport per session ID
  private readonly sseTransports = new Map<string, SSEServerTransport>();

  /** Call after McpServer.start() to enable the /mcp/sse endpoint. */
  setMcpServer(mcp: McpServer): void { this.mcpServer = mcp; }

  constructor(config: GatewayConfig, keyStore: KeyStore) {
    this.config = config;
    this.app    = express();

    this.app.use(express.json());

    // Serve static dashboard files
    const dashboardDir = join(__dirname, '..', 'dashboard');
    this.app.use('/assets', express.static(join(dashboardDir, 'assets')));

    // Dashboard SPA — all routes serve index.html
    this.app.get('/', (_req: Request, res: Response) => {
      res.sendFile(join(dashboardDir, 'index.html'));
    });

    // API routes
    const api = express.Router();
    registerRpcProxyRoutes(api, config);
    registerPolicyRoutes(api, config);
    registerSessionRoutes(api, config);
    registerKeystoreRoutes(api, keyStore);
    registerSettingsRoutes(api, config);
    if (config.privy) {
      registerAuthRoutes(api, config.privy.appId, config.privy.appSecret);
    }
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

    // ── MCP over SSE ──────────────────────────────────────────────────────
    // Claude Code / AI agents connect to GET /mcp/sse to receive server messages
    // and POST to /mcp/messages?sessionId=<id> to send requests.
    // Configure in Claude Code settings.json:
    //   { "mcpServers": { "echo-gateway": { "type": "sse", "url": "http://127.0.0.1:<PORT>/mcp/sse" } } }
    this.app.get('/mcp/sse', async (req: Request, res: Response) => {
      if (!this.mcpServer) {
        res.status(503).json({ error: 'MCP server not ready' });
        return;
      }
      const transport = new SSEServerTransport('/mcp/messages', res);
      this.sseTransports.set(transport.sessionId, transport);
      res.on('close', () => this.sseTransports.delete(transport.sessionId));
      await this.mcpServer.getServer().connect(transport);
    });

    this.app.post('/mcp/messages', async (req: Request, res: Response) => {
      const sessionId = req.query['sessionId'] as string;
      const transport = this.sseTransports.get(sessionId);
      if (!transport) {
        res.status(400).json({ error: `No active SSE session: ${sessionId}` });
        return;
      }
      await transport.handlePostMessage(req, res);
    });

    // MCP setup endpoint — provides local paths so the browser can generate
    // a stdio MCP config without needing dist to include .env contents.
    this.app.get('/api/mcp-setup', (_req: Request, res: Response) => {
      try {
        // HttpServer runtime path is: <root>/dist/http
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
    return new Promise((resolve) => {
      const server = createServer(this.app);
      server.listen(this.config.port, '127.0.0.1', () => {
        console.error(`[Echo Gateway] Dashboard: http://127.0.0.1:${this.config.port}`);
        resolve();
      });
    });
  }
}