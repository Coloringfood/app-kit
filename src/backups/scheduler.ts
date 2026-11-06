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

type Running = { stop: () => void };
const schedulers = ((globalThis as { __coloringfoodAppKitSchedulers?: Map<string, Running> })
  .__coloringfoodAppKitSchedulers ??= new Map<string, Running>());

/** Returns a function that stops the scheduler. Timers are unref'd so they never keep the process alive. */
export function startBackupScheduler({
  key,
  run,
  intervalMs = 10 * 60_000,
  initialDelayMs = 60_000,
  onError = error => console.error(`[app-kit] scheduled backup "${key}" failed:`, error),
}: SchedulerOptions): () => void {
  const existing = schedulers.get(key);
  if (existing) return existing.stop;

  let busy = false;
  let interval: ReturnType<typeof setInterval> | undefined;

  const tick = () => {
    if (busy) return;
    busy = true;
    run()
      .catch(onError)
      .finally(() => {
        busy = false;
      });
  };

  const first = setTimeout(() => {
    tick();
    interval = setInterval(tick, intervalMs);
    interval.unref?.();
  }, initialDelayMs);
  first.unref?.();

  const stop = () => {
    clearTimeout(first);
    if (interval) clearInterval(interval);
    schedulers.delete(key);
  };
  schedulers.set(key, { stop });
  return stop;
}
