export declare class CorruptJsonFileError extends Error {
    readonly filePath: string;
    constructor(filePath: string, options?: {
        cause?: unknown;
    });
}
export declare function readJsonFile<T>(filePath: string, defaultValue: T): Promise<T>;
export interface WriteOptions {
    /** Called when the write has to fall back to a non-atomic in-place write. Defaults to console.warn. */
    onWarning?: (message: string) => void;
    /**
     * What to do when Windows keeps refusing the rename because readers hold the file:
     * - 'write-in-place' (default): after ~127ms of 1ms-escalating retries, write in place. Short and
     *   never fails, but a concurrent read can see a torn file. chore-conqueror relies on this; longer
     *   delays broke its E2E specs.
     * - 'retry': keep retrying (backoff capped at 100ms) for up to `retryForMs`, then throw. Always atomic.
     * Irrelevant on Linux, where the rename never fails this way.
     */
    onRenameBlocked?: 'write-in-place' | 'retry';
    /** How long 'retry' keeps trying. Default 60s (like graceful-fs). */
    retryForMs?: number;
}
export declare function writeFileAtomic(filePath: string, contents: string | Uint8Array, { onWarning, onRenameBlocked, retryForMs }?: WriteOptions): Promise<void>;
export declare function writeJsonFile(filePath: string, data: unknown, { space, ...options }?: WriteOptions & {
    space?: number;
}): Promise<void>;
