import { describe, it, expect } from 'vitest';
import { namedLock } from './lock.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('namedLock', () => {
  it('runs sections one at a time, in call order', async () => {
    const lock = namedLock('test-order');
    const events: string[] = [];
    const task = (name: string, ms: number) => lock(async () => {
      events.push(`${name}:start`);
      await sleep(ms);
      events.push(`${name}:end`);
      return name;
    });

    expect(await Promise.all([task('a', 15), task('b', 1), task('c', 5)])).toEqual(['a', 'b', 'c']);
    expect(events).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
  });

  it('keeps going after a section throws and hands the error to that caller', async () => {
    const lock = namedLock('test-errors');

    const failing = lock(async () => { throw new Error('boom'); });
    const next = lock(async () => 'ok');

    await expect(failing).rejects.toThrow('boom');
    await expect(next).resolves.toBe('ok');
  });

  it('shares one queue per name across separate lookups (separate route bundles)', async () => {
    const events: string[] = [];
    const first = namedLock('test-shared')(async () => { await sleep(10); events.push('first'); });
    const second = namedLock('test-shared')(async () => { events.push('second'); });
    await Promise.all([first, second]);

    expect(events).toEqual(['first', 'second']);
  });

  it('does not serialize different names against each other', async () => {
    const events: string[] = [];
    const slow = namedLock('test-a')(async () => { await sleep(20); events.push('a'); });
    const fast = namedLock('test-b')(async () => { events.push('b'); });
    await Promise.all([slow, fast]);

    expect(events).toEqual(['b', 'a']);
  });
});
