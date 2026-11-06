const schedulers = (globalThis
    .__coloringfoodAppKitSchedulers ??= new Map());
/** Returns a function that stops the scheduler. Timers are unref'd so they never keep the process alive. */
export function startBackupScheduler({ key, run, intervalMs = 10 * 60_000, initialDelayMs = 60_000, onError = error => console.error(`[app-kit] scheduled backup "${key}" failed:`, error), }) {
    const existing = schedulers.get(key);
    if (existing)
        return existing.stop;
    let busy = false;
    let interval;
    const tick = () => {
        if (busy)
            return;
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
        if (interval)
            clearInterval(interval);
        schedulers.delete(key);
    };
    schedulers.set(key, { stop });
    return stop;
}
