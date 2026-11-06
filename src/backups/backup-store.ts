/**
 * In-app, restic-style backups for apps that keep their data in files (JSON, SQLite, anything) or
 * can dump it on demand.
 *
 * Layout under `dir`:
 *
 *   <id>/meta.json          what, when, why, sha256 per entry, optional app summary
 *   <id>/<source>.gz        one gzipped entry per source
 *
 * A backup is assembled in `.tmp-*` and renamed into place, so `list()` never sees a partial one.
 * Backups live next to the data, so they protect against app bugs and bad imports, not a dead
 * disk: offer downloads (readEntry) for an off-machine copy.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { gzip as gzipCb, gunzip as gunzipCb } from 'node:zlib';
import { writeFileAtomic } from '../json-file.js';
import { namedLock } from '../lock.js';
import { DEFAULT_RETENTION, hourBucket, selectBackupsToKeep, type RetentionPolicy } from './retention.js';

const gzip = promisify(gzipCb);
const gunzip = promisify(gunzipCb);

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

export type ScheduledResult =
  | { status: 'created'; backup: BackupInfo; pruned: string[] }
  | { status: 'unchanged' | 'too-soon' | 'empty'; backup?: undefined; pruned: string[] };

export class BackupIntegrityError extends Error {
  constructor(id: string, entry: string) {
    super(`Backup ${id} entry ${entry} does not match its checksum`);
    this.name = 'BackupIntegrityError';
  }
}

export const SCHEDULED_REASON = 'scheduled';
const ID_PATTERN = /^\d{8}T\d{9}Z-[a-z][a-z0-9-]{0,39}$/;
const REASON_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const TEMP_PREFIX = '.tmp-';
const STALE_TEMP_MS = 3_600_000;

const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');
const isFileSource = (s: BackupSource): s is FileBackupSource => 'path' in s;
const compactIso = (d: Date) => d.toISOString().replace(/[-:.]/g, '');

export function createBackupStore(options: BackupStoreOptions) {
  const { dir, sources, retention = DEFAULT_RETENTION, keepOther = 10, summarize } = options;

  const seen = new Set<string>();
  for (const source of sources) {
    if (!NAME_PATTERN.test(source.name) || source.name.includes('..')) {
      throw new Error(`Invalid backup source name "${source.name}"`);
    }
    if (source.name === 'meta.json') throw new Error('"meta.json" is a reserved backup source name');
    if (seen.has(source.name)) throw new Error(`Duplicate backup source name "${source.name}"`);
    seen.add(source.name);
  }

  // Serializes create/prune/scheduled runs against each other (not against the app's own data lock).
  const lock = namedLock(`app-kit-backups:${path.resolve(dir)}`);

  async function readSources(): Promise<Map<string, Buffer>> {
    const entries = new Map<string, Buffer>();
    for (const source of sources) {
      if (isFileSource(source)) {
        try {
          entries.set(source.name, await fs.readFile(source.path));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      } else {
        const data = await source.read();
        if (data !== null) entries.set(source.name, Buffer.from(data));
      }
    }
    return entries;
  }

  const fingerprintOf = (entries: Map<string, Buffer>) =>
    sha256([...entries].map(([name, data]) => `${name}:${sha256(data)}`).sort().join('\n'));

  async function list(): Promise<BackupInfo[]> {
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const backups: BackupInfo[] = [];
    for (const name of names.filter(n => ID_PATTERN.test(n))) {
      try {
        backups.push(JSON.parse(await fs.readFile(path.join(dir, name, 'meta.json'), 'utf-8')) as BackupInfo);
      } catch {
        // An unreadable meta.json means an unusable backup; leave it on disk for a human, don't list it.
      }
    }
    return backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  }

  async function get(id: string): Promise<BackupInfo> {
    if (!ID_PATTERN.test(id)) throw new Error(`Unknown backup "${id}"`);
    try {
      return JSON.parse(await fs.readFile(path.join(dir, id, 'meta.json'), 'utf-8')) as BackupInfo;
    } catch {
      throw new Error(`Unknown backup "${id}"`);
    }
  }

  async function readEntry(id: string, name: string): Promise<Buffer> {
    const info = await get(id);
    const entry = info.entries.find(e => e.name === name);
    if (!entry) throw new Error(`Backup ${id} has no entry "${name}"`);
    const data = await gunzip(await fs.readFile(path.join(dir, id, `${name}.gz`)));
    if (sha256(data) !== entry.sha256) throw new BackupIntegrityError(id, name);
    return data;
  }

  async function readEntries(id: string): Promise<Map<string, Buffer>> {
    const info = await get(id);
    const entries = new Map<string, Buffer>();
    for (const entry of info.entries) entries.set(entry.name, await readEntry(id, entry.name));
    return entries;
  }

  async function write(entries: Map<string, Buffer>, reason: string, now: Date): Promise<BackupInfo> {
    await fs.mkdir(dir, { recursive: true });
    let stamp = now.getTime();
    let id = `${compactIso(new Date(stamp))}-${reason}`;
    while (await fs.access(path.join(dir, id)).then(() => true, () => false)) {
      id = `${compactIso(new Date(++stamp))}-${reason}`;
    }

    let summary: BackupSummary | undefined;
    try {
      summary = summarize?.(entries) ?? undefined;
    } catch {
      summary = undefined;
    }

    const temp = path.join(dir, `${TEMP_PREFIX}${id}-${randomUUID()}`);
    await fs.mkdir(temp);
    try {
      const infoEntries: BackupEntryInfo[] = [];
      let storedBytes = 0;
      for (const [name, data] of entries) {
        const compressed = await gzip(data);
        await fs.writeFile(path.join(temp, `${name}.gz`), compressed);
        storedBytes += compressed.length;
        infoEntries.push({ name, bytes: data.length, sha256: sha256(data) });
      }
      const info: BackupInfo = {
        id,
        createdAt: now.toISOString(),
        reason,
        entries: infoEntries,
        totalBytes: infoEntries.reduce((sum, e) => sum + e.bytes, 0),
        storedBytes,
        fingerprint: fingerprintOf(entries),
        ...(summary ? { summary } : {}),
      };
      await fs.writeFile(path.join(temp, 'meta.json'), JSON.stringify(info, null, 2));
      await fs.rename(temp, path.join(dir, id));
      return info;
    } catch (error) {
      await fs.rm(temp, { recursive: true, force: true });
      throw error;
    }
  }

  async function pruneUnlocked(): Promise<string[]> {
    const all = await list();
    const scheduled = all.filter(b => b.reason === SCHEDULED_REASON);
    const keep = selectBackupsToKeep(scheduled, retention);
    for (const other of all.filter(b => b.reason !== SCHEDULED_REASON).slice(0, keepOther)) keep.add(other);

    const removed: string[] = [];
    for (const backup of all) {
      if (keep.has(backup)) continue;
      await fs.rm(path.join(dir, backup.id), { recursive: true, force: true });
      removed.push(backup.id);
    }

    // Partial backups left by a crash. Young ones may still be in progress in another call.
    for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
      if (!name.startsWith(TEMP_PREFIX)) continue;
      const full = path.join(dir, name);
      const stat = await fs.stat(full).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > STALE_TEMP_MS) await fs.rm(full, { recursive: true, force: true });
    }
    return removed;
  }

  /** Take a backup now, e.g. right before an import, reset or restore. Returns null if there is no data yet. */
  async function create(reason: string, { now = new Date() }: { now?: Date } = {}): Promise<BackupInfo | null> {
    if (reason === SCHEDULED_REASON) throw new Error('"scheduled" backups are taken by runScheduled()');
    if (!REASON_PATTERN.test(reason)) throw new Error(`Invalid backup reason "${reason}" (use a lowercase slug)`);
    return lock(async () => {
      const entries = await readSources();
      if (entries.size === 0) return null;
      const info = await write(entries, reason, now);
      await pruneUnlocked();
      return info;
    });
  }

  /** Call regularly (see startBackupScheduler). Backs up at most once per hour, and only when the data changed. */
  async function runScheduled({ now = new Date() }: { now?: Date } = {}): Promise<ScheduledResult> {
    return lock(async () => {
      const latest = (await list()).find(b => b.reason === SCHEDULED_REASON);
      if (latest && hourBucket(new Date(latest.createdAt)) === hourBucket(now)) {
        return { status: 'too-soon', pruned: await pruneUnlocked() };
      }
      const entries = await readSources();
      if (entries.size === 0) return { status: 'empty', pruned: await pruneUnlocked() };
      if (latest && latest.fingerprint === fingerprintOf(entries)) {
        return { status: 'unchanged', pruned: await pruneUnlocked() };
      }
      const backup = await write(entries, SCHEDULED_REASON, now);
      return { status: 'created', backup, pruned: await pruneUnlocked() };
    });
  }

  async function prune(): Promise<string[]> {
    return lock(pruneUnlocked);
  }

  /**
   * Write every file source in a backup back to its path (atomically). Custom sources are skipped:
   * the app restores those itself from readEntry(). Run this inside the app's own data lock, and
   * close any open SQLite connection first.
   */
  async function restoreFiles(id: string, { backupFirst }: { backupFirst?: string } = {}): Promise<string[]> {
    const entries = await readEntries(id);
    if (backupFirst) await create(backupFirst);
    const restored: string[] = [];
    for (const source of sources) {
      if (!isFileSource(source)) continue;
      const data = entries.get(source.name);
      if (!data) continue;
      await writeFileAtomic(source.path, data);
      restored.push(source.name);
    }
    return restored;
  }

  return { create, runScheduled, list, get, readEntry, readEntries, prune, restoreFiles };
}

export type BackupStore = ReturnType<typeof createBackupStore>;
