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
import { DEFAULT_RETENTION, hourBucket, selectBackupsToKeep } from './retention.js';
const gzip = promisify(gzipCb);
const gunzip = promisify(gunzipCb);
export class BackupIntegrityError extends Error {
    constructor(id, entry) {
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
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const isFileSource = (s) => 'path' in s;
const compactIso = (d) => d.toISOString().replace(/[-:.]/g, '');
export function createBackupStore(options) {
    const { dir, sources, retention = DEFAULT_RETENTION, keepOther = 10, summarize } = options;
    const seen = new Set();
    for (const source of sources) {
        if (!NAME_PATTERN.test(source.name) || source.name.includes('..')) {
            throw new Error(`Invalid backup source name "${source.name}"`);
        }
        if (source.name === 'meta.json')
            throw new Error('"meta.json" is a reserved backup source name');
        if (seen.has(source.name))
            throw new Error(`Duplicate backup source name "${source.name}"`);
        seen.add(source.name);
    }
    // Serializes create/prune/scheduled runs against each other (not against the app's own data lock).
    const lock = namedLock(`app-kit-backups:${path.resolve(dir)}`);
    async function readSources() {
        const entries = new Map();
        for (const source of sources) {
            if (isFileSource(source)) {
                try {
                    entries.set(source.name, await fs.readFile(source.path));
                }
                catch (error) {
                    if (error.code !== 'ENOENT')
                        throw error;
                }
            }
            else {
                const data = await source.read();
                if (data !== null)
                    entries.set(source.name, Buffer.from(data));
            }
        }
        return entries;
    }
    const fingerprintOf = (entries) => sha256([...entries].map(([name, data]) => `${name}:${sha256(data)}`).sort().join('\n'));
    async function list() {
        let names;
        try {
            names = await fs.readdir(dir);
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return [];
            throw error;
        }
        const backups = [];
        for (const name of names.filter(n => ID_PATTERN.test(n))) {
            try {
                backups.push(JSON.parse(await fs.readFile(path.join(dir, name, 'meta.json'), 'utf-8')));
            }
            catch {
                // An unreadable meta.json means an unusable backup; leave it on disk for a human, don't list it.
            }
        }
        return backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    }
    async function get(id) {
        if (!ID_PATTERN.test(id))
            throw new Error(`Unknown backup "${id}"`);
        try {
            return JSON.parse(await fs.readFile(path.join(dir, id, 'meta.json'), 'utf-8'));
        }
        catch {
            throw new Error(`Unknown backup "${id}"`);
        }
    }
    async function readEntry(id, name) {
        const info = await get(id);
        const entry = info.entries.find(e => e.name === name);
        if (!entry)
            throw new Error(`Backup ${id} has no entry "${name}"`);
        const data = await gunzip(await fs.readFile(path.join(dir, id, `${name}.gz`)));
        if (sha256(data) !== entry.sha256)
            throw new BackupIntegrityError(id, name);
        return data;
    }
    async function readEntries(id) {
        const info = await get(id);
        const entries = new Map();
        for (const entry of info.entries)
            entries.set(entry.name, await readEntry(id, entry.name));
        return entries;
    }
    async function write(entries, reason, now) {
        await fs.mkdir(dir, { recursive: true });
        let stamp = now.getTime();
        let id = `${compactIso(new Date(stamp))}-${reason}`;
        while (await fs.access(path.join(dir, id)).then(() => true, () => false)) {
            id = `${compactIso(new Date(++stamp))}-${reason}`;
        }
        let summary;
        try {
            summary = summarize?.(entries) ?? undefined;
        }
        catch {
            summary = undefined;
        }
        const temp = path.join(dir, `${TEMP_PREFIX}${id}-${randomUUID()}`);
        await fs.mkdir(temp);
        try {
            const infoEntries = [];
            let storedBytes = 0;
            for (const [name, data] of entries) {
                const compressed = await gzip(data);
                await fs.writeFile(path.join(temp, `${name}.gz`), compressed);
                storedBytes += compressed.length;
                infoEntries.push({ name, bytes: data.length, sha256: sha256(data) });
            }
            const info = {
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
        }
        catch (error) {
            await fs.rm(temp, { recursive: true, force: true });
            throw error;
        }
    }
    async function pruneUnlocked() {
        const all = await list();
        const scheduled = all.filter(b => b.reason === SCHEDULED_REASON);
        const keep = selectBackupsToKeep(scheduled, retention);
        for (const other of all.filter(b => b.reason !== SCHEDULED_REASON).slice(0, keepOther))
            keep.add(other);
        const removed = [];
        for (const backup of all) {
            if (keep.has(backup))
                continue;
            await fs.rm(path.join(dir, backup.id), { recursive: true, force: true });
            removed.push(backup.id);
        }
        // Partial backups left by a crash. Young ones may still be in progress in another call.
        for (const name of await fs.readdir(dir).catch(() => [])) {
            if (!name.startsWith(TEMP_PREFIX))
                continue;
            const full = path.join(dir, name);
            const stat = await fs.stat(full).catch(() => null);
            if (stat && Date.now() - stat.mtimeMs > STALE_TEMP_MS)
                await fs.rm(full, { recursive: true, force: true });
        }
        return removed;
    }
    /** Take a backup now, e.g. right before an import, reset or restore. Returns null if there is no data yet. */
    async function create(reason, { now = new Date() } = {}) {
        if (reason === SCHEDULED_REASON)
            throw new Error('"scheduled" backups are taken by runScheduled()');
        if (!REASON_PATTERN.test(reason))
            throw new Error(`Invalid backup reason "${reason}" (use a lowercase slug)`);
        return lock(async () => {
            const entries = await readSources();
            if (entries.size === 0)
                return null;
            const info = await write(entries, reason, now);
            await pruneUnlocked();
            return info;
        });
    }
    /** Call regularly (see startBackupScheduler). Backs up at most once per hour, and only when the data changed. */
    async function runScheduled({ now = new Date() } = {}) {
        return lock(async () => {
            const latest = (await list()).find(b => b.reason === SCHEDULED_REASON);
            if (latest && hourBucket(new Date(latest.createdAt)) === hourBucket(now)) {
                return { status: 'too-soon', pruned: await pruneUnlocked() };
            }
            const entries = await readSources();
            if (entries.size === 0)
                return { status: 'empty', pruned: await pruneUnlocked() };
            if (latest && latest.fingerprint === fingerprintOf(entries)) {
                return { status: 'unchanged', pruned: await pruneUnlocked() };
            }
            const backup = await write(entries, SCHEDULED_REASON, now);
            return { status: 'created', backup, pruned: await pruneUnlocked() };
        });
    }
    async function prune() {
        return lock(pruneUnlocked);
    }
    /**
     * Write every file source in a backup back to its path (atomically). Custom sources are skipped:
     * the app restores those itself from readEntry(). Run this inside the app's own data lock, and
     * close any open SQLite connection first.
     */
    async function restoreFiles(id, { backupFirst } = {}) {
        const entries = await readEntries(id);
        if (backupFirst)
            await create(backupFirst);
        const restored = [];
        for (const source of sources) {
            if (!isFileSource(source))
                continue;
            const data = entries.get(source.name);
            if (!data)
                continue;
            await writeFileAtomic(source.path, data);
            restored.push(source.name);
        }
        return restored;
    }
    return { create, runScheduled, list, get, readEntry, readEntries, prune, restoreFiles };
}
