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
export declare const DEFAULT_RETENTION: Readonly<RetentionPolicy>;
export declare function selectBackupsToKeep<T extends {
    createdAt: string | Date;
}>(items: readonly T[], policy?: RetentionPolicy): Set<T>;
/** The hourly bucket a time falls in; used to take at most one scheduled backup per hour. */
export declare const hourBucket: (d: Date) => string;
