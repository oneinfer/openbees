import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBeesDbPath, ensureBeesStateDirs } from '../paths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

ensureBeesStateDirs();

const dbPath = resolveBeesDbPath();

const db: import('better-sqlite3').Database = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf-8');
db.exec(schema);
ensureTaskSchema(db);

function ensureTaskSchema(database: import('better-sqlite3').Database): void {
  const expectedColumns = new Map<string, string>([
    ['task_kind', "TEXT NOT NULL DEFAULT 'task'"],
    ['task_mode', "TEXT NOT NULL DEFAULT 'direct'"],
    ['workspace_path', 'TEXT'],
    ['agent_runtime', 'TEXT'],
    ['last_context_used_tokens', 'INTEGER'],
    ['last_context_window_tokens', 'INTEGER'],
  ]);
  const existingColumns = new Set<string>(
    (
      database
        .prepare("SELECT name FROM pragma_table_info('tasks')")
        .all() as Array<{ name: string }>
    ).map(column => column.name),
  );

  for (const [columnName, columnType] of expectedColumns) {
    if (existingColumns.has(columnName)) continue;
    database.exec(`ALTER TABLE tasks ADD COLUMN ${columnName} ${columnType}`);
  }
}

export default db;
