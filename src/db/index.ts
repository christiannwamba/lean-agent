import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';

import * as schema from './schema.js';

export const DB_PATH = resolve(process.cwd(), 'data', 'lean-agent.db');

mkdirSync(dirname(DB_PATH), { recursive: true });

export const sqlite = new Database(DB_PATH);
export const db = drizzle({ client: sqlite, schema });

export { schema };
