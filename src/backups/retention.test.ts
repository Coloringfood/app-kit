import { describe, it, expect } from 'vitest';
import { selectBackupsToKeep, DEFAULT_RETENTION, type RetentionPolicy } from './retention.js';

const NONE: RetentionPolicy = { hourly: 0, sixHourly: 0, daily: 0, weekly: 0, monthly: 0 };
const at = (iso: string) => ({ createdAt: iso });
const kept = (items: { createdAt: string }[], policy: RetentionPolicy) =>
  [...selectBackupsToKeep(items, policy)].map(i => i.createdAt).sort();

/** One backup per hour, ending at `end` (inclusive), newest last. */
function hourly(end: string, count: number) {
  const endMs = Date.parse(end);
  return Array.from({ length: count }, (_, i) => at(new Date(endMs - (count - 1 - i) * 3_600_000).toISOString()));
}

describe('selectBackupsToKeep', () => {
  it('defaults to 6 hourly, 4 six-hourly, 7 daily, 4 weekly, 6 monthly', () => {
    expect(DEFAULT_RETENTION).toEqual({ hourly: 6, sixHourly: 4, daily: 7, weekly: 4, monthly: 6 });
  });

  it('keeps the newest backup in each of the last N hours', () => {
    const items = [
      at('2026-11-06T10:05:00.000Z'),
      at('2026-11-06T10:45:00.000Z'), // newer in the same hour wins
      at('2026-11-06T11:10:00.000Z'),
      at('2026-11-06T12:10:00.000Z'),
    ];

    expect(kept(items, { ...NONE, hourly: 2 })).toEqual(['2026-11-06T11:10:00.000Z', '2026-11-06T12:10:00.000Z']);
    expect(kept(items, { ...NONE, hourly: 5 })).toEqual([
      '2026-11-06T10:45:00.000Z', '2026-11-06T11:10:00.000Z', '2026-11-06T12:10:00.000Z',
    ]);
  });

  it('buckets six-hourly on 00/06/12/18 UTC', () => {
    const items = hourly('2026-11-06T23:00:00.000Z', 24); // one per hour across 2026-11-06

    expect(kept(items, { ...NONE, sixHourly: 4 })).toEqual([
      '2026-11-06T05:00:00.000Z', '2026-11-06T11:00:00.000Z', '2026-11-06T17:00:00.000Z', '2026-11-06T23:00:00.000Z',
    ]);
  });

  it('keeps one per day, week (Monday start) and month', () => {
    const items = [
      at('2026-09-15T08:00:00.000Z'),
      at('2026-10-20T08:00:00.000Z'),
      at('2026-10-31T08:00:00.000Z'), // Saturday
      at('2026-11-01T08:00:00.000Z'), // Sunday, same ISO week as the 31st
      at('2026-11-02T08:00:00.000Z'), // Monday, new week
      at('2026-11-02T20:00:00.000Z'),
    ];

    expect(kept(items, { ...NONE, daily: 2 })).toEqual(['2026-11-01T08:00:00.000Z', '2026-11-02T20:00:00.000Z']);
    expect(kept(items, { ...NONE, weekly: 3 })).toEqual([
      '2026-10-20T08:00:00.000Z', '2026-11-01T08:00:00.000Z', '2026-11-02T20:00:00.000Z',
    ]);
    expect(kept(items, { ...NONE, monthly: 3 })).toEqual([
      '2026-09-15T08:00:00.000Z', '2026-10-31T08:00:00.000Z', '2026-11-02T20:00:00.000Z',
    ]);
  });

  it('keeps the union of every rule, like restic forget', () => {
    // Two weeks of hourly backups.
    const items = hourly('2026-11-06T15:30:00.000Z', 24 * 14);

    const result = kept(items, DEFAULT_RETENTION);

    // hourly:     15:30 14:30 13:30 12:30 11:30 10:30 (11-06)
    // six-hourly: 15:30, 11:30, 05:30 (11-06) and 23:30 (11-05) — the newest in each of 4 buckets
    // daily:      the last backup of 11-06 … 10-31
    // weekly:     newest in the weeks starting Mon 11-02, 10-26, 10-19 (data starts 10-23)
    // monthly:    newest in Nov and Oct
    expect(result).toContain('2026-11-06T15:30:00.000Z');
    expect(result).toContain('2026-11-06T10:30:00.000Z');
    expect(result).not.toContain('2026-11-06T09:30:00.000Z'); // its six-hourly bucket keeps 11:30
    expect(result).toContain('2026-11-06T05:30:00.000Z');
    expect(result).toContain('2026-11-05T23:30:00.000Z');
    expect(result).not.toContain('2026-11-05T17:30:00.000Z'); // would be the 5th six-hourly bucket
    expect(result).toContain('2026-10-31T23:30:00.000Z'); // daily (7th day back) and monthly
    expect(result).toContain('2026-10-25T23:30:00.000Z'); // weekly: Sunday ends a week
    expect(result).not.toContain('2026-10-26T23:30:00.000Z'); // a mid-week day older than 7 days
    expect(new Set(result).size).toBe(result.length);
    expect(result.length).toBeLessThan(6 + 4 + 7 + 4 + 6);
  });

  it('accepts unsorted input and Date values', () => {
    const items = [{ createdAt: new Date('2026-11-06T09:00:00Z') }, { createdAt: new Date('2026-11-06T12:00:00Z') }];

    const result = selectBackupsToKeep(items, { ...NONE, hourly: 1 });

    expect([...result]).toEqual([items[1]]);
  });

  it('keeps nothing when every count is zero', () => {
    expect(selectBackupsToKeep(hourly('2026-11-06T00:00:00Z', 5), NONE).size).toBe(0);
  });
});
