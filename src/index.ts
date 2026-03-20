#!/usr/bin/env node
/**
 * Echo Gateway — entry point.
 *
 * Startup sequence:
 *   1. Load config from environment variables
 *   2. Prompt for KeyStore passphrase (stdin, never logged)
 *   3. Unlock KeyStore — decrypts signing keys into memory
 *   4. Start McpServer on stdio
 *
 * The gateway runs as a local process. OpenClaw connects to it via
 * stdio MCP transport. The process stays alive until SIGINT/SIGTERM.
 *
 * Usage:
 *   node dist/index.js
 *   # or during development:
 *   npx tsx src/index.ts
 *
 * Environment:
 *   Copy .env.example → .env in the project root (same cwd as `npm run dev`).
 *   Values are loaded automatically from `.env` on startup (existing OS env wins).
 */

import { createInterface } from 'node:readline';
import { loadDotEnv } from './config/loadDotEnv.js';
import { loadConfig }  from './config/index.js';
import { KeyStore }    from './keystore/KeyStore.js';
import { McpServer }   from './mcp/McpServer.js';
import { HttpServer }  from './http/HttpServer.js';

// ── Main ───────────────────────────────────────────────────────────────────

// ── Terminal styling ──────────────────────────────────────────────────────

const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  green:  '\x1b[38;2;0;255;135m',
  white:  '\x1b[38;2;232;232;232m',
  gray:   '\x1b[38;2;102;102;102m',
  red:    '\x1b[38;2;255;59;59m',
  yellow: '\x1b[38;2;255;107;53m',
  bg:     '\x1b[48;2;10;10;10m',
} as const;

function log(icon: string, color: string, msg: string): void {
  console.error(`  ${color}${icon}${C.reset}  ${C.white}${msg}${C.reset}`);
}
function logOk(msg: string):    void { log('✓', C.green,  msg); }
function logInfo(msg: string):  void { log('→', C.gray,   msg); }
function logError(msg: string): void { log('✗', C.red,    msg); }
function logWarn(msg: string):  void { log('!', C.yellow, msg); }

function printBanner(): void {
  const line = `${C.dim}${'─'.repeat(52)}${C.reset}`;
  console.error('');
  console.error(`  ${C.green}${C.bold}ECHO GATEWAY${C.reset}  ${C.dim}v0.1.0 · Sepolia${C.reset}`);
  console.error(`  ${line}`);
}

function printReady(port: number): void {
  const line = `${C.dim}${'─'.repeat(52)}${C.reset}`;
  console.error(`  ${line}`);
  console.error(`  ${C.gray}Dashboard${C.reset}   ${C.green}http://127.0.0.1:${port}${C.reset}`);
  console.error(`  ${C.gray}MCP server${C.reset}  ${C.green}ready${C.reset}  ${C.dim}(stdio)${C.reset}`);
  console.error(`  ${line}`);
  console.error(`  ${C.dim}Press Ctrl+C to stop${C.reset}`);
  console.error('');
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  printBanner();

  loadDotEnv();

  // 1. Load config
  let config;
  try {
    config = loadConfig();
    logOk('Config loaded');
  } catch (err) {
    logError(`Config error: ${err instanceof Error ? err.message : err}`);
    logWarn('Copy .env.example to .env and fill in all required values.');
    process.exit(1);
  }

  // 2. Prompt for passphrase
  const passphrase = await promptPassphrase();

  // 3. Unlock KeyStore
  const keyStore = new KeyStore(config.keystorePath);
  try {
    await keyStore.unlock(passphrase);
    logOk(`KeyStore unlocked`);
    logInfo(config.keystorePath);
  } catch (err) {
    logError(`Wrong passphrase or corrupted KeyStore`);
    process.exit(1);
  }

  // 4. Start HTTP server (Dashboard)
  const httpServer = new HttpServer(config, keyStore);
  await httpServer.start();

  // 5. Start MCP server
  const server = new McpServer(config, keyStore);
  await server.start();

  printReady(config.port);

  // Graceful shutdown
  const shutdown = (signal: string) => {
    console.error('');
    logWarn(`${signal} — locking KeyStore and exiting`);
    keyStore.lock();
    process.exit(0);
  };

  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// ── Passphrase prompt ──────────────────────────────────────────────────────

/**
 * Prompt for KeyStore passphrase on stderr (not stdout, which is used by MCP).
 * Input is not echoed to the terminal.
 */
async function promptPassphrase(): Promise<string> {
  // In CI or non-interactive mode, read from ECHO_KEYSTORE_PASSPHRASE env var
  if (process.env['ECHO_KEYSTORE_PASSPHRASE']) {
    logOk('Passphrase loaded from environment');
    return process.env['ECHO_KEYSTORE_PASSPHRASE'];
  }

  return new Promise((resolve) => {
    const rl = createInterface({
      input:  process.stdin,
      output: process.stderr,
      terminal: true,
    });

    process.stderr.write(`  ${C.gray}KeyStore passphrase${C.reset}  `);

    // Disable echoing if possible
    if (process.stdin.isTTY) {
      (process.stdin as NodeJS.ReadStream & { setRawMode?: (mode: boolean) => void })
        .setRawMode?.(true);
    }

    let passphrase = '';

    process.stdin.on('data', (chunk: Buffer) => {
      const char = chunk.toString();

      if (char === '\n' || char === '\r') {
        if (process.stdin.isTTY) {
          (process.stdin as NodeJS.ReadStream & { setRawMode?: (mode: boolean) => void })
            .setRawMode?.(false);
        }
        process.stderr.write('\n');
        rl.close();
        resolve(passphrase);
      } else if (char === '\u0003') {
        // Ctrl+C
        process.stderr.write('\n[Echo Gateway] Cancelled\n');
        process.exit(0);
      } else if (char === '\u007f' || char === '\b') {
        // Backspace
        passphrase = passphrase.slice(0, -1);
      } else {
        passphrase += char;
      }
    });
  });
}

// ── Run ────────────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error('[Echo Gateway] Fatal error:', err);
  process.exit(1);
});
