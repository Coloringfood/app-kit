import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { gzipSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { createBackupStore, BackupIntegrityError, type BackupSource } from './backup-store.js';

let root: string;
let backupDir: string;
let dataFile: string;
let dbFile: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'app-kit-backups-'));
  backupDir = path.join(root, 'backups');
  dataFile = path.join(root, 'data.json');
  dbFile = path.join(root, 'app.sqlite');
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const T = (iso: string) => new Date(iso);

function store(extra: Partial<Parameters<typeof createBackupStore>[0]> = {}) {
  const sources: BackupSource[] = [{ name: 'data.json', path: dataFile }];
  return createBackupStore({ dir: backupDir, sources, ...extra });
}

describe('create / list / read', () => {
  it('snapshots every source and reads it back byte for byte', async () => {
    await fs.writeFile(dataFile, '{"kids":[1,2,3]}');
    const binary = Buffer.from([0x53, 0x51, 0x4c, 0x00, 0xff, 0x10]);
    await fs.writeFile(dbFile, binary);
    const backups = createBackupStore({
      dir: backupDir,
      sources: [{ name: 'data.json', path: dataFile }, { name: 'app.sqlite', path: dbFile }],
    });

    const info = await backups.create('before-import', { now: T('2026-11-06T16:00:00.000Z') });

    expect(info).not.toBeNull();
    expect(info!.reason).toBe('before-import');
    expect(info!.createdAt).toBe('2026-11-06T16:00:00.000Z');
    expect(info!.entries.map(e => e.name)).toEqual(['data.json', 'app.sqlite']);
    expect((await backups.readEntry(info!.id, 'data.json')).toString('utf-8')).toBe('{"kids":[1,2,3]}');
    expect(await backups.readEntry(info!.id, 'app.sqlite')).toEqual(binary);
    expect((await backups.list()).map(b => b.id)).toEqual([info!.id]);
  });

  it('reads custom sources, e.g. a database dump', async () => {
    const backups = createBackupStore({
      dir: backupDir,
      sources: [{ name: 'store.json', read: async () => '{"from":"mongo"}' }],
    });

    const info = await backups.create('manual');

    expect((await backups.readEntry(info!.id, 'store.json')).toString()).toBe('{"from":"mongo"}');
  });

  it('skips missing sources and returns null when there is nothing to back up', async () => {
    const backups = store();

    expect(await backups.create('manual')).toBeNull();
    expect(await backups.list()).toEqual([]);
  });

  it('stores a summary computed by the app', async () => {
    await fs.writeFile(dataFile, '{"kids":[1,2,3]}');
    const backups = store({
      summarize: entries => ({ kids: JSON.parse(entries.get('data.json')!.toString()).kids.length }),
    });

    const info = await backups.create('manual');

    expect(info!.summary).toEqual({ kids: 3 });
    expect((await backups.list())[0].summary).toEqual({ kids: 3 });
  });

  it('still backs up when the summary throws (e.g. the data is corrupt)', async () => {
    await fs.writeFile(dataFile, '{"kids": [');
    const backups = store({ summarize: entries => JSON.parse(entries.get('data.json')!.toString()) });

    const info = await backups.create('manual');

    expect(info!.summary).toBeUndefined();
    expect((await backups.readEntry(info!.id, 'data.json')).toString()).toBe('{"kids": [');
  });

  it('lists newest first and gives same-millisecond backups distinct ids', async () => {
    await fs.writeFile(dataFile, '1');
    const backups = store();
    const now = T('2026-11-06T16:00:00.000Z');

    const a = await backups.create('manual', { now });
    const b = await backups.create('manual', { now });
    const c = await backups.create('manual', { now: T('2026-11-06T17:00:00.000Z') });

    expect(new Set([a!.id, b!.id, c!.id]).size).toBe(3);
    expect((await backups.list())[0].id).toBe(c!.id);
  });

  it('never lists a backup that was only partly written', async () => {
    await fs.writeFile(dataFile, '1');
    const backups = store();
    await backups.create('manual');
    await fs.mkdir(path.join(backupDir, '.tmp-20261106T160000000Z-manual-abc'), { recursive: true });

    expect(await backups.list()).toHaveLength(1);
  });

  it('rejects ids and entry names that could escape the backup directory', async () => {
    await fs.writeFile(dataFile, '1');
    const backups = store();
    const info = await backups.create('manual');

    await expect(backups.readEntry('../../etc', 'data.json')).rejects.toThrow(/Unknown backup/);
    await expect(backups.readEntry(info!.id, '../data.json')).rejects.toThrow(/no entry/);
  });

  it('detects a tampered or corrupt entry', async () => {
    await fs.writeFile(dataFile, 'original');
    const backups = store();
    const info = await backups.create('manual');
    await fs.writeFile(path.join(backupDir, info!.id, 'data.json.gz'), gzipSync('changed'));

    await expect(backups.readEntry(info!.id, 'data.json')).rejects.toBeInstanceOf(BackupIntegrityError);
  });

  it('rejects reasons that are not simple slugs and reserves "scheduled"', async () => {
    await fs.writeFile(dataFile, '1');
    const backups = store();

    await expect(backups.create('Before Import')).rejects.toThrow(/reason/);
    await expect(backups.create('scheduled')).rejects.toThrow(/scheduled/);
  });

  it('rejects duplicate or unsafe source names up front', () => {
    expect(() => createBackupStore({ dir: backupDir, sources: [{ name: 'a', path: 'x' }, { name: 'a', path: 'y' }] }))
      .toThrow(/duplicate/i);
    expect(() => createBackupStore({ dir: backupDir, sources: [{ name: '../a', path: 'x' }] })).toThrow(/name/);
    expect(() => createBackupStore({ dir: backupDir, sources: [{ name: 'meta.json', path: 'x' }] })).toThrow(/reserved/);
  });
});

describe('runScheduled', () => {
  it('creates a backup, then skips while the data is unchanged', async () => {
    await fs.writeFile(dataFile, 'v1');
    const backups = store();

    const first = await backups.runScheduled({ now: T('2026-11-06T10:00:00Z') });
    const second = await backups.runScheduled({ now: T('2026-11-06T13:00:00Z') });

    expect(first.status).toBe('created');
    expect(first.backup!.reason).toBe('scheduled');
    expect(second.status).toBe('unchanged');
    expect(await backups.list()).toHaveLength(1);
  });

  it('takes at most one scheduled backup per hour', async () => {
    await fs.writeFile(dataFile, 'v1');
    const backups = store();
    await backups.runScheduled({ now: T('2026-11-06T10:05:00Z') });
    await fs.writeFile(dataFile, 'v2');

    expect((await backups.runScheduled({ now: T('2026-11-06T10:55:00Z') })).status).toBe('too-soon');
    expect((await backups.runScheduled({ now: T('2026-11-06T11:00:00Z') })).status).toBe('created');
  });

  it('reports empty when no source exists yet', async () => {
    expect((await store().runScheduled()).status).toBe('empty');
  });

  it('prunes scheduled backups to the retention policy as it goes', async () => {
    const backups = store({ retention: { hourly: 3, sixHourly: 0, daily: 0, weekly: 0, monthly: 0 } });
    for (let h = 0; h < 6; h++) {
      await fs.writeFile(dataFile, `v${h}`);
      await backups.runScheduled({ now: T(`2026-11-06T${String(10 + h).padStart(2, '0')}:00:00Z`) });
    }

    const remaining = await backups.list();

    expect(remaining.map(b => b.createdAt)).toEqual([
      '2026-11-06T15:00:00.000Z', '2026-11-06T14:00:00.000Z', '2026-11-06T13:00:00.000Z',
    ]);
    expect(await fs.readdir(backupDir)).toHaveLength(3);
  });
});

describe('prune', () => {
  it('keeps the newest N non-scheduled (safety) backups separately from the schedule', async () => {
    await fs.writeFile(dataFile, '1');
    const backups = store({ keepOther: 2, retention: { hourly: 1, sixHourly: 0, daily: 0, weekly: 0, monthly: 0 } });
    await backups.runScheduled({ now: T('2026-11-06T09:00:00Z') });
    for (const hour of ['10', '11', '12']) {
      await backups.create('before-import', { now: T(`2026-11-06T${hour}:00:00Z`) });
    }

    // create() prunes as it goes, so the oldest safety backup is already gone.
    const left = await backups.list();

    expect(await backups.prune()).toEqual([]);
    expect(left.map(b => `${b.reason}@${b.createdAt.slice(11, 13)}`)).toEqual([
      'before-import@12', 'before-import@11', 'scheduled@09',
    ]);
  });

  it('cleans up partial backups left behind by a crash once they are an hour old', async () => {
    const stale = path.join(backupDir, '.tmp-old');
    const fresh = path.join(backupDir, '.tmp-new');
    await fs.mkdir(stale, { recursive: true });
    await fs.mkdir(fresh, { recursive: true });
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000);
    await fs.utimes(stale, twoHoursAgo, twoHoursAgo);

    await store().prune();

    expect(await fs.readdir(backupDir)).toEqual(['.tmp-new']);
  });
});

describe('restoreFiles', () => {
  it('writes every file source back to its path', async () => {
    await fs.writeFile(dataFile, 'good');
    const backups = store();
    const info = await backups.create('manual');
    await fs.writeFile(dataFile, '[]');

    const restored = await backups.restoreFiles(info!.id);

    expect(restored).toEqual(['data.json']);
    expect(await fs.readFile(dataFile, 'utf-8')).toBe('good');
  });

  it('can take a safety backup of the current files first', async () => {
    await fs.writeFile(dataFile, 'good');
    const backups = store();
    const info = await backups.create('manual', { now: T('2026-11-06T10:00:00Z') });
    await fs.writeFile(dataFile, 'newer');

    await backups.restoreFiles(info!.id, { backupFirst: 'before-restore' });

    const safety = (await backups.list()).find(b => b.reason === 'before-restore')!;
    expect((await backups.readEntry(safety.id, 'data.json')).toString()).toBe('newer');
    expect(await fs.readFile(dataFile, 'utf-8')).toBe('good');
  });

  it('does not touch custom sources (the app restores those itself)', async () => {
    const backups = createBackupStore({ dir: backupDir, sources: [{ name: 'db.json', read: async () => 'x' }] });
    const info = await backups.create('manual');

    expect(await backups.restoreFiles(info!.id)).toEqual([]);
  });
});
