import { cpSync, mkdirSync } from 'node:fs';

mkdirSync('dist', { recursive: true });
cpSync('src/dashboard', 'dist/dashboard', { recursive: true, force: true });
