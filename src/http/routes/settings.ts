import type { Router, Request, Response } from 'express';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GatewayConfig } from '../../config/index.js';

const ALLOWED_KEYS = [
  'SEPOLIA_RPC_URL',
  'PIMLICO_API_KEY',
  'CHAIN_ID',
  'GATEWAY_PORT',
] as const;

type AllowedKey = (typeof ALLOWED_KEYS)[number];

function parseDotEnv(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = rawLine.match(/^([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1];
    if (!key) continue;
    out[key] = m[2] ?? '';
  }
  return out;
}

function upsertDotEnv(lines: string[], key: string, value: string): string[] {
  const idx = lines.findIndex(l => l.match(new RegExp(`^${key}\\s*=`)));
  const nextLine = `${key}=${value}`;
  if (idx >= 0) {
    lines[idx] = nextLine;
  } else {
    // Ensure the file ends with a newline-ish separation
    const last = lines[lines.length - 1];
    if (last && last.trim() !== '') lines.push('');
    lines.push(nextLine);
  }
  return lines;
}

export function registerSettingsRoutes(router: Router, config: GatewayConfig): void {
  router.get('/settings', (_req: Request, res: Response) => {
    try {
      // HttpServer runtime path is: <root>/dist/http
      // This file runtime path is: <root>/dist/http/routes
      const gatewayRoot = join(__dirname, '..', '..', '..');
      const envPath = join(gatewayRoot, '.env');
      const contents = readFileSync(envPath, 'utf8');
      const env = parseDotEnv(contents);

      const sepoliaRpcUrl = env.SEPOLIA_RPC_URL ?? '';
      const chainId = env.CHAIN_ID ? Number(env.CHAIN_ID) : NaN;
      const gatewayPort = env.GATEWAY_PORT ? Number(env.GATEWAY_PORT) : NaN;
      const pimlicoApiKeyPresent = !!(env.PIMLICO_API_KEY ?? '').trim();

      res.json({
        sepoliaRpcUrl,
        chainId: Number.isFinite(chainId) ? chainId : config.chainId,
        gatewayPort: Number.isFinite(gatewayPort) ? gatewayPort : config.port,
        pimlicoApiKeyPresent,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/settings', async (req: Request, res: Response) => {
    try {
      const body = req.body as Partial<Record<AllowedKey, unknown>>;

      // Load current .env
      const gatewayRoot = join(__dirname, '..', '..', '..');
      const envPath = join(gatewayRoot, '.env');
      const contents = readFileSync(envPath, 'utf8');
      const lines = contents.split(/\r?\n/);

      // Validate + update only allowed keys.
      const nextValues: Partial<Record<AllowedKey, string>> = {};

      if (body.SEPOLIA_RPC_URL !== undefined) {
        const v = String(body.SEPOLIA_RPC_URL).trim();
        if (!/^https?:\/\//i.test(v)) throw new Error('SEPOLIA_RPC_URL must be a valid http(s) URL');
        nextValues.SEPOLIA_RPC_URL = v;
      }

      if (body.CHAIN_ID !== undefined) {
        const v = Number(body.CHAIN_ID);
        if (!Number.isInteger(v) || v <= 0) throw new Error('CHAIN_ID must be a positive integer');
        nextValues.CHAIN_ID = String(v);
      }

      if (body.GATEWAY_PORT !== undefined) {
        const v = Number(body.GATEWAY_PORT);
        if (!Number.isInteger(v) || v <= 0 || v >= 65536) throw new Error('GATEWAY_PORT must be 1..65535');
        nextValues.GATEWAY_PORT = String(v);
      }

      if (body.PIMLICO_API_KEY !== undefined) {
        const v = String(body.PIMLICO_API_KEY).trim();
        if (!v) throw new Error('PIMLICO_API_KEY cannot be empty');
        nextValues.PIMLICO_API_KEY = v;
      }

      for (const k of Object.keys(nextValues) as AllowedKey[]) {
        lines.splice(0, lines.length, ...upsertDotEnv(lines, k, nextValues[k]!));
      }

      writeFileSync(envPath, lines.join('\n'), 'utf8');

      res.json({ ok: true, updated: Object.keys(nextValues), note: 'Please restart the gateway to apply changes.' });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}

