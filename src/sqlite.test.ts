import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sqliteSnapshot, sqliteSource, replaceSqliteFile } from './sqlite.js';
import { createBackupStore } from './backups/index.js';

let dir: string;
let dbPath: string;
let db: DatabaseSync;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "app-kit-sqlite-it's-"));
  dbPath = path.join(dir, 'app.db');
  db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL; CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO items (name) VALUES ('rice'), ('beans');");
});

afterEach(async () => {
  try { db.close(); } catch { /* already closed */ }
  await fs.rm(dir, { recursive: true, force: true });
});

const exec = (sql: string) => { db.exec(sql); };
const rowsIn = (file: string) => {
  const copy = new DatabaseSync(file);
  try {
    return copy.prepare('SELECT name FROM items ORDER BY id').all().map(r => (r as { name: string }).name);
  } finally {
    copy.close();
  }
};

describe('sqliteSnapshot', () => {
  it('produces a consistent copy of an open WAL database, including uncheckpointed writes', async () => {
    db.exec("INSERT INTO items (name) VALUES ('flour')"); // lives in the -wal file until checkpoint

    const bytes = await sqliteSnapshot(exec, { tempDir: dir });

    const restored = path.join(dir, 'restored.db');
    await fs.writeFile(restored, bytes);
    expect(rowsIn(restored)).toEqual(['rice', 'beans', 'flour']);
  });

  it('cleans up its temp file, even when the snapshot fails', async () => {
    const before = (await fs.readdir(dir)).sort();
    await sqliteSnapshot(exec, { tempDir: dir });
    await expect(sqliteSnapshot(() => { throw new Error('locked'); }, { tempDir: dir })).rejects.toThrow('locked');

    expect((await fs.readdir(dir)).sort()).toEqual(before);
  });

  it('handles a temp path with a quote in it (escaped in the SQL)', async () => {
    expect(dir).toContain("'");

    const bytes = await sqliteSnapshot(exec, { tempDir: dir });

    expect(bytes.subarray(0, 15).toString()).toBe('SQLite format 3');
  });
});

describe('sqliteSource with a backup store', () => {
  it('backs up and restores a database round trip', async () => {
    const backups = createBackupStore({
      dir: path.join(dir, 'backups'),
      sources: [sqliteSource('app.db', exec, { tempDir: dir })],
    });
    const info = await backups.create('manual');
    db.exec("DELETE FROM items");
    db.close();

    await replaceSqliteFile(dbPath, await backups.readEntry(info!.id, 'app.db'));

    expect(rowsIn(dbPath)).toEqual(['rice', 'beans']);
  });
});

describe('replaceSqliteFile', () => {
  it('replaces the file and removes stale -wal/-shm/-journal files', async () => {
    db.close();
    const replacement = await fs.readFile(dbPath);
    for (const suffix of ['-wal', '-shm', '-journal']) await fs.writeFile(dbPath + suffix, 'stale');

    await replaceSqliteFile(dbPath, replacement);

    expect((await fs.readdir(dir)).filter(n => n.startsWith('app.db'))).toEqual(['app.db']);
  });

  it('refuses bytes that are not an SQLite database', async () => {
    db.close();
    await expect(replaceSqliteFile(dbPath, Buffer.from('[]'))).rejects.toThrow(/not an SQLite database/);
    expect(rowsIn(dbPath)).toEqual(['rice', 'beans']);
  });
});
