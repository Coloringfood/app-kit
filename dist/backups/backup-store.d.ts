import { type RetentionPolicy } from './retention.js';
/** A file copied byte for byte. Use for JSON files written atomically, or any file not open for writing. */
export interface FileBackupSource {
    name: string;
    path: string;
}
/**
 * Data the app produces itself: a database dump, a store read through the app's own API, or a
 * consistent SQLite copy (`VACUUM INTO` / better-sqlite3 `db.backup()`; copying a live SQLite file
 * byte for byte can catch it mid-transaction). Return null when there's nothing to back up yet.
 */
export interface CustomBackupSource {
    name: string;
    read: () => Promise<string | Uint8Array | null>;
}
export type BackupSource = FileBackupSource | CustomBackupSource;
export type BackupSummary = Record<string, string | number>;
export interface BackupEntryInfo {
    name: string;
    /** Uncompressed size. */
    bytes: number;
    sha256: string;
}
export interface BackupInfo {
    id: string;
    createdAt: string;
    /** "scheduled" for automatic backups; any other slug (e.g. "before-import") for safety backups. */
    reason: string;
    entries: BackupEntryInfo[];
    totalBytes: number;
    storedBytes: number;
    /** Hash over every entry; equal fingerprints mean identical data. */
    fingerprint: string;
    summary?: BackupSummary;
}
export interface BackupStoreOptions {
    dir: string;
    sources: BackupSource[];
    /** Applied to scheduled backups. */
    retention?: RetentionPolicy;
    /** How many of the newest non-scheduled (safety) backups to keep. Default 10. */
    keepOther?: number;
    /** Small facts shown next to each backup (e.g. counts). Errors are ignored: corrupt data still gets backed up. */
    summarize?: (entries: Map<string, Buffer>) => BackupSummary | undefined;
}
export type ScheduledResult = {
    status: 'created';
    backup: BackupInfo;
    pruned: string[];
} | {
    status: 'unchanged' | 'too-soon' | 'empty';
    backup?: undefined;
    pruned: string[];
};
export declare class BackupIntegrityError extends Error {
    constructor(id: string, entry: string);
}
export declare const SCHEDULED_REASON = "scheduled";
export declare function createBackupStore(options: BackupStoreOptions): {
    create: (reason: string, { now }?: {
        now?: Date;
    }) => Promise<BackupInfo | null>;
    runScheduled: ({ now }?: {
        now?: Date;
    }) => Promise<ScheduledResult>;
    list: () => Promise<BackupInfo[]>;
    get: (id: string) => Promise<BackupInfo>;
    readEntry: (id: string, name: string) => Promise<Buffer>;
    readEntries: (id: string) => Promise<Map<string, Buffer>>;
    prune: () => Promise<string[]>;
    restoreFiles: (id: string, { backupFirst }?: {
        backupFirst?: string;
    }) => Promise<string[]>;
};
export type BackupStore = ReturnType<typeof createBackupStore>;
