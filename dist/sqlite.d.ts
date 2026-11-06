import type { CustomBackupSource } from './backups/backup-store.js';
export type SqlExec = (sql: string) => unknown | Promise<unknown>;
/** A consistent copy of the database as bytes. `tempDir` should be on the same disk as the database. */
export declare function sqliteSnapshot(exec: SqlExec, { tempDir }: {
    tempDir: string;
}): Promise<Buffer>;
/** A backup source for createBackupStore that snapshots the database with VACUUM INTO. */
export declare function sqliteSource(name: string, exec: SqlExec, options: {
    tempDir: string;
}): CustomBackupSource;
/**
 * Put a backed-up database in place. **Close every connection to `dbPath` first** and reopen after.
 * Writes atomically, then removes leftover -wal/-shm/-journal files, which belong to the old database
 * and would corrupt the restored one if SQLite replayed them.
 */
export declare function replaceSqliteFile(dbPath: string, bytes: Uint8Array): Promise<void>;
