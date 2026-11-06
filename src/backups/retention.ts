/**
 * restic-style retention ("forget --keep-hourly … --keep-monthly"): for each rule, walk the backups
 * newest first and keep the newest backup in each of the last N distinct time buckets. The result is
 * the union of every rule, so one backup can satisfy several rules at once.
 *
 * Buckets are computed in UTC so the result doesn't shift with the server's time zone or DST.
 */
export interface RetentionPolicy {
  /** Newest backup in each of the last N clock hours. */
  hourly: number;
  /** Newest backup in each of the last N six-hour blocks (00, 06, 12, 18 UTC). */
  sixHourly: number;
  /** Newest backup in each of the last N days. */
  daily: number;
  /** Newest backup in each of the last N weeks (Monday start). */
  weekly: number;
  /** Newest backup in each of the last N calendar months. */
  monthly: number;
}

export const DEFAULT_RETENTION: Readonly<RetentionPolicy> = Object.freeze({
  hourly: 6,
  sixHourly: 4,
  daily: 7,
  weekly: 4,
  monthly: 6,
});

const DAY_MS = 86_400_000;

const bucketKey: Record<keyof RetentionPolicy, (d: Date) => string> = {
  hourly: d => d.toISOString().slice(0, 13),
  sixHourly: d => `${d.toISOString().slice(0, 10)}/${Math.floor(d.getUTCHours() / 6)}`,
  daily: d => d.toISOString().slice(0, 10),
  // 1970-01-01 was a Thursday, so shifting by 3 days puts week boundaries on Mondays.
  weekly: d => String(Math.floor((Math.floor(d.getTime() / DAY_MS) + 3) / 7)),
  monthly: d => d.toISOString().slice(0, 7),
};

export function selectBackupsToKeep<T extends { createdAt: string | Date }>(
  items: readonly T[],
  policy: RetentionPolicy = DEFAULT_RETENTION,
): Set<T> {
  const newestFirst = items
    .map(item => ({ item, at: new Date(item.createdAt) }))
    .sort((a, b) => b.at.getTime() - a.at.getTime());

  const keep = new Set<T>();
  for (const rule of Object.keys(bucketKey) as (keyof RetentionPolicy)[]) {
    const limit = policy[rule];
    let lastBucket: string | undefined;
    let buckets = 0;
    for (const { item, at } of newestFirst) {
      if (buckets >= limit) break;
      const bucket = bucketKey[rule](at);
      if (bucket === lastBucket) continue;
      lastBucket = bucket;
      buckets++;
      keep.add(item);
    }
  }
  return keep;
}

/** The hourly bucket a time falls in; used to take at most one scheduled backup per hour. */
export const hourBucket = (d: Date) => bucketKey.hourly(d);
