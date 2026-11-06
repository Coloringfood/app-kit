/**
 * Crash-safe JSON files.
 *
 * Two rules, both learned from real data loss:
 *
 * 1. A file that can't be read or parsed is NOT "no data". Only a missing file falls back to the
 *    default. Anything else throws, because returning `[]` hands the app an empty store and its next
 *    write replaces everyone's data with it. (priority-todo lost every user's todos this way on
 *    2026-11-06; chore-conqueror nearly did earlier.)
 * 2. Writes are atomic: write a sibling temp file, then rename it over the target. A plain
 *    `fs.writeFile` truncates first, so a concurrent read can parse a half-written file.
 *
 * Atomic writes stop torn reads; they don't stop lost updates. Wrap read-modify-write in a lock
 * (see ./lock).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
export class CorruptJsonFileError extends Error {
    filePath;
    constructor(filePath, options) {
        super(`Refusing to use ${path.basename(filePath)}: it is not valid JSON`, options);
        this.filePath = filePath;
        this.name = 'CorruptJsonFileError';
    }
}
const code = (error) => error?.code ?? '';
export async function readJsonFile(filePath, defaultValue) {
    let content;
    try {
        content = await fs.readFile(filePath, 'utf-8');
    }
    catch (error) {
        if (code(error) === 'ENOENT')
            return structuredClone(defaultValue);
        throw error;
    }
    try {
        return JSON.parse(content);
    }
    catch (cause) {
        throw new CorruptJsonFileError(filePath, { cause });
    }
}
/**
 * Windows `MoveFileEx` refuses to replace a file another handle has open, which happens routinely
 * (every read opens it). Handles are held for microseconds, so retry on a short 1ms-escalating
 * backoff. Keep this short: in chore-conqueror a flat 25ms delay measurably widened the window for
 * one write to land on top of another. Linux never hits this.
 */
const CONTENTION_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_ATTEMPTS = 8;
/** The temp file needs permission on the directory; an in-place write only needs it on the file. */
const DIR_UNWRITABLE_CODES = new Set(['EACCES', 'EPERM', 'EROFS']);
let writeSequence = 0;
async function renameWithRetry(from, to) {
    for (let attempt = 1; attempt <= RENAME_ATTEMPTS; attempt++) {
        try {
            await fs.rename(from, to);
            return true;
        }
        catch (error) {
            if (process.platform !== 'win32' || !CONTENTION_CODES.has(code(error)))
                throw error;
            if (attempt === RENAME_ATTEMPTS)
                return false;
            await new Promise(resolve => setTimeout(resolve, 2 ** (attempt - 1)));
        }
    }
    return false;
}
export async function writeFileAtomic(filePath, contents, { onWarning = console.warn } = {}) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    // Unique per write so concurrent writers never interleave bytes in a shared temp file.
    const temp = `${filePath}.${process.pid}.${++writeSequence}.tmp`;
    try {
        await fs.writeFile(temp, contents);
    }
    catch (error) {
        await fs.unlink(temp).catch(() => undefined);
        if (!DIR_UNWRITABLE_CODES.has(code(error)))
            throw error;
        // e.g. a Docker volume owned by another uid: the file is writable, the directory isn't.
        onWarning(`[app-kit] cannot create a temp file beside ${filePath} (${code(error)}); writing in place, ` +
            'which is not crash-safe. Fix the ownership of the directory.');
        await fs.writeFile(filePath, contents);
        return;
    }
    try {
        if (await renameWithRetry(temp, filePath))
            return;
    }
    catch (error) {
        await fs.unlink(temp).catch(() => undefined);
        throw error;
    }
    // Windows only, and only if readers held the file through every attempt: a save that fails
    // outright is worse than one that might be read torn.
    onWarning(`[app-kit] rename onto ${filePath} was blocked ${RENAME_ATTEMPTS} times; writing in place.`);
    await fs.writeFile(filePath, contents);
    await fs.unlink(temp).catch(() => undefined);
}
export async function writeJsonFile(filePath, data, options = {}) {
    await writeFileAtomic(filePath, JSON.stringify(data, null, options.space ?? 2), options);
}
