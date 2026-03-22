/**
 * ActivityLog — lightweight append-only log for submitted UserOps.
 *
 * Stored at the same directory as the keystore (e.g. ~/.echo/activity.json).
 * No external dependencies; survives gateway restarts.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface ActivityEntry {
  instanceId:  string;
  txHash:      string;
  userOpHash:  string;
  tokenIn:     string;
  tokenOut:    string;
  amountIn:    string;   // raw units
  amountOut:   string;   // raw units
  feeTier:     number;
  sessionId:   string | null;  // null = realtime
  timestamp:   number;   // ms since epoch
}

export class ActivityLog {
  private readonly path: string;

  constructor(keystorePath: string) {
    this.path = keystorePath.replace('keystore.json', 'activity.json');
  }

  append(entry: ActivityEntry): void {
    const entries = this._read();
    entries.unshift(entry);            // newest first
    if (entries.length > 500) entries.splice(500);  // cap size
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(entries, null, 2));
  }

  list(instanceId?: string): ActivityEntry[] {
    const entries = this._read();
    if (!instanceId) return entries;
    return entries.filter(e => e.instanceId.toLowerCase() === instanceId.toLowerCase());
  }

  private _read(): ActivityEntry[] {
    if (!existsSync(this.path)) return [];
    try {
      return JSON.parse(readFileSync(this.path, 'utf8')) as ActivityEntry[];
    } catch {
      return [];
    }
  }
}
