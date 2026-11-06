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
}
export declare function writeFileAtomic(filePath: string, contents: string | Uint8Array, { onWarning }?: WriteOptions): Promise<void>;
export declare function writeJsonFile(filePath: string, data: unknown, options?: WriteOptions & {
    space?: number;
}): Promise<void>;
