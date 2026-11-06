/**
 * SQLite helpers for backups. Driver-agnostic: pass a function that runs one SQL statement on the
 * app's open connection (sqlite3/sqlite `db.exec`, better-sqlite3 `db.exec`, node:sqlite `db.exec`).
 *
 * Don't byte-copy a live database: a copy taken mid-transaction (or without the -wal file) can be
 * inconsistent. `VACUUM INTO` asks SQLite itself for a consistent, compacted copy (SQLite >= 3.27).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeFileAtomic } from './json-file.js';
const SQLITE_HEADER = 'SQLite format 3\u0000';
/** A consistent copy of the database as bytes. `tempDir` should be on the same disk as the database. */
export async function sqliteSnapshot(exec, { tempDir }) {
    await fs.mkdir(tempDir, { recursive: true });
    const temp = path.join(tempDir, `.sqlite-snapshot-${randomUUID()}.db`);
    try {
        await exec(`VACUUM INTO '${temp.replace(/'/g, "''")}'`);
        return await fs.readFile(temp);
    }
    finally {
        await fs.rm(temp, { force: true });
    }
}
/** A backup source for createBackupStore that snapshots the database with VACUUM INTO. */
export function sqliteSource(name, exec, options) {
    return { name, read: () => sqliteSnapshot(exec, options) };
}
/**
 * Put a backed-up database in place. **Close every connection to `dbPath` first** and reopen after.
 * Writes atomically, then removes leftover -wal/-shm/-journal files, which belong to the old database
 * and would corrupt the restored one if SQLite replayed them.
 */
export async function replaceSqliteFile(dbPath, bytes) {
    if (Buffer.from(bytes.subarray(0, 16)).toString('latin1') !== SQLITE_HEADER) {
        throw new Error('Refusing to restore: the backup is not an SQLite database');
    }
    await writeFileAtomic(dbPath, bytes, { onRenameBlocked: 'retry' });
    for (const suffix of ['-wal', '-shm', '-journal'])
        await fs.rm(dbPath + suffix, { force: true });
}
