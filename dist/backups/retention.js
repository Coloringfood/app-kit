export const DEFAULT_RETENTION = Object.freeze({
    hourly: 6,
    sixHourly: 4,
    daily: 7,
    weekly: 4,
    monthly: 6,
});
const DAY_MS = 86_400_000;
const bucketKey = {
    hourly: d => d.toISOString().slice(0, 13),
    sixHourly: d => `${d.toISOString().slice(0, 10)}/${Math.floor(d.getUTCHours() / 6)}`,
    daily: d => d.toISOString().slice(0, 10),
    // 1970-01-01 was a Thursday, so shifting by 3 days puts week boundaries on Mondays.
    weekly: d => String(Math.floor((Math.floor(d.getTime() / DAY_MS) + 3) / 7)),
    monthly: d => d.toISOString().slice(0, 7),
};
export function selectBackupsToKeep(items, policy = DEFAULT_RETENTION) {
    const newestFirst = items
        .map(item => ({ item, at: new Date(item.createdAt) }))
        .sort((a, b) => b.at.getTime() - a.at.getTime());
    const keep = new Set();
    for (const rule of Object.keys(bucketKey)) {
        const limit = policy[rule];
        let lastBucket;
        let buckets = 0;
        for (const { item, at } of newestFirst) {
            if (buckets >= limit)
                break;
            const bucket = bucketKey[rule](at);
            if (bucket === lastBucket)
                continue;
            lastBucket = bucket;
            buckets++;
            keep.add(item);
        }
    }
    return keep;
}
/** The hourly bucket a time falls in; used to take at most one scheduled backup per hour. */
export const hourBucket = (d) => bucketKey.hourly(d);
