export interface SchedulerOptions {
    /** Identifies this scheduler; starting the same key twice is a no-op (Next can call register() more than once). */
    key: string;
    run: () => Promise<unknown>;
    /** How often to check. The backup store itself limits scheduled backups to one per hour. Default 10 min. */
    intervalMs?: number;
    /** Delay before the first check, so startup isn't slowed. Default 60 s. */
    initialDelayMs?: number;
    onError?: (error: unknown) => void;
}
/** Returns a function that stops the scheduler. Timers are unref'd so they never keep the process alive. */
export declare function startBackupScheduler({ key, run, intervalMs, initialDelayMs, onError, }: SchedulerOptions): () => void;
