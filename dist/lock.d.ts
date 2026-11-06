export type Lock = <T>(fn: () => Promise<T>) => Promise<T>;
export declare function namedLock(name: string): Lock;
