import { describe, it, expect, vi, afterEach } from 'vitest';
import { startBackupScheduler } from './scheduler.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('startBackupScheduler', () => {
  it('runs after the initial delay and then on every interval', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => undefined);
    const stop = startBackupScheduler({ key: 'sched-basic', run, initialDelayMs: 1000, intervalMs: 5000 });

    await vi.advanceTimersByTimeAsync(999);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run).toHaveBeenCalledTimes(3);

    stop();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('starts only once per key, so a second register() call is harmless', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => undefined);
    const stop = startBackupScheduler({ key: 'sched-once', run, initialDelayMs: 0, intervalMs: 1000 });
    startBackupScheduler({ key: 'sched-once', run, initialDelayMs: 0, intervalMs: 1000 });

    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    stop();
  });

  it('skips a tick while the previous run is still going', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const run = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const stop = startBackupScheduler({ key: 'sched-overlap', run, initialDelayMs: 0, intervalMs: 100 });

    await vi.advanceTimersByTimeAsync(350);
    expect(run).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(100);
    expect(run).toHaveBeenCalledTimes(2);
    stop();
  });

  it('reports a failing run and keeps the schedule alive', async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const run = vi.fn(async () => { throw new Error('disk full'); });
    const stop = startBackupScheduler({ key: 'sched-error', run, onError, initialDelayMs: 0, intervalMs: 100 });

    await vi.advanceTimersByTimeAsync(250);

    expect(onError).toHaveBeenCalledTimes(3);
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
    stop();
  });
});
