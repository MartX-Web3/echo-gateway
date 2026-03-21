/**
 * Load `.env` from process.cwd() into process.env (does not override existing vars).
 * Node does not read `.env` by itself; `npm run dev` uses plain `tsx` without `--env-file`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function loadDotEnv(): void {
  // Try process.cwd() first, then the gateway root relative to this file
  // (handles subprocess mode where CWD may not be the gateway directory).
  const scriptRoot = new URL('../..', import.meta.url).pathname
    .replace(/^\/([A-Za-z]:)/, '$1'); // strip leading slash on Windows paths
  const candidates = [join(process.cwd(), '.env'), join(scriptRoot, '.env')];
  const envPath = candidates.find(p => existsSync(p));
  if (!envPath) return;

  for (const rawLine of readFileSync(envPath, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq <= 0) continue;

    const key = line.slice(0, eq).trim();
    if (!key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
