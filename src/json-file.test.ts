import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJsonFile, writeJsonFile, writeFileAtomic, CorruptJsonFileError } from './json-file.js';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'app-kit-json-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('readJsonFile', () => {
  it('returns a fresh copy of the default for a missing file and does not create it', async () => {
    const file = path.join(dir, 'missing.json');
    const fallback: number[] = [];

    const value = await readJsonFile(file, fallback);
    value.push(1);

    expect(await readJsonFile(file, fallback)).toEqual([]);
    await expect(fs.access(file)).rejects.toThrow();
  });

  it('throws CorruptJsonFileError on unparseable or empty content and leaves the file alone', async () => {
    const file = path.join(dir, 'todos.json');
    for (const content of ['[{"id":', '']) {
      await fs.writeFile(file, content);
      await expect(readJsonFile(file, [])).rejects.toBeInstanceOf(CorruptJsonFileError);
      expect(await fs.readFile(file, 'utf-8')).toBe(content);
    }
  });

  it('propagates other read errors instead of falling back', async () => {
    // Reading a directory as a file fails with EISDIR, not ENOENT.
    await expect(readJsonFile(dir, [])).rejects.toMatchObject({ code: 'EISDIR' });
  });
});

describe('writeFileAtomic / writeJsonFile', () => {
  it('writes, creates the directory, and leaves no temp files', async () => {
    const file = path.join(dir, 'nested', 'data.json');

    await writeJsonFile(file, { a: 1 });

    expect(JSON.parse(await fs.readFile(file, 'utf-8'))).toEqual({ a: 1 });
    expect(await fs.readdir(path.dirname(file))).toEqual(['data.json']);
  });

  it('writes binary content unchanged', async () => {
    const file = path.join(dir, 'blob.bin');
    const bytes = Uint8Array.from([0, 255, 1, 254]);

    await writeFileAtomic(file, bytes);

    expect(new Uint8Array(await fs.readFile(file))).toEqual(bytes);
  });

  it('never exposes a half-written file to a concurrent reader', async () => {
    const file = path.join(dir, 'big.json');
    const big = (n: number) => Array.from({ length: 3000 }, (_, i) => ({ id: `${n}-${i}`, pad: 'x'.repeat(100) }));
    await writeJsonFile(file, big(0));

    let done = false;
    const failures: string[] = [];
    let reads = 0;
    const writer = (async () => {
      for (let n = 1; n <= 15; n++) await writeJsonFile(file, big(n));
      done = true;
    })();
    const reader = (async () => {
      while (!done) {
        try {
          JSON.parse(await fs.readFile(file, 'utf-8'));
          reads++;
        } catch (e) {
          failures.push(String(e));
        }
        await new Promise(resolve => setImmediate(resolve));
      }
    })();
    await Promise.all([writer, reader]);

    expect(reads).toBeGreaterThan(0);
    expect(failures).toEqual([]);
  }, 20_000);
});
