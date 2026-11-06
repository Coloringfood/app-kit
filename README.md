# @coloringfood/app-kit

Shared server-side building blocks for the Coloringfood apps (priority-todo, chore-conqueror, pantry-wise, …):

| Import | What it gives you |
|---|---|
| `@coloringfood/app-kit/json-file` | `readJsonFile` (only a *missing* file falls back to the default; corrupt content throws `CorruptJsonFileError` and is never overwritten), `writeJsonFile` / `writeFileAtomic` (temp file + rename, so readers never see a half-written file) |
| `@coloringfood/app-kit/lock` | `namedLock(name)`: an in-process mutex shared across Next.js route bundles. Wrap every read-modify-write in it. |
| `@coloringfood/app-kit/backups` | restic-style in-app backups: `createBackupStore`, `startBackupScheduler`, `selectBackupsToKeep` |

Server-only (uses `node:fs`). Node 20+. ESM.

## Install

Consumers depend on a tagged GitHub tarball. That needs no git binary and no token in Docker builds, and the lockfile records an integrity hash:

```jsonc
"dependencies": {
  "@coloringfood/app-kit": "https://github.com/Coloringfood/app-kit/archive/refs/tags/v0.1.0.tar.gz"
}
```

To upgrade, change the tag and run `npm install` with the app's pinned npm.

## Backups

```ts
import { createBackupStore, startBackupScheduler } from '@coloringfood/app-kit/backups';

export const backups = createBackupStore({
  dir: path.join(process.cwd(), 'data', 'backups'),     // must be on the persistent volume
  sources: [
    { name: 'todos.json', path: path.join(dataDir, 'todos.json') },       // copied byte for byte
    { name: 'app.sqlite', read: async () => dumpSqliteConsistently() },    // or produce it yourself
  ],
  // retention defaults to { hourly: 6, sixHourly: 4, daily: 7, weekly: 4, monthly: 6 }
  // keepOther: 10   (newest safety backups, i.e. any reason other than "scheduled")
  summarize: entries => ({ todos: JSON.parse(entries.get('todos.json')!.toString()).length }),
});

// src/instrumentation.ts (Next.js)
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { backups } = await import('./lib/backups');
  startBackupScheduler({ key: 'my-app', run: () => backups.runScheduled() });
}

// Before anything destructive (import, reset, restore), take a safety backup and refuse if it fails:
await backups.create('before-import');
```

- **Scheduled backups:** `runScheduled()` backs up at most once per clock hour, and only when the data's fingerprint changed. It prunes on every run. Retention works like `restic forget --keep-*`: within each rule, keep the newest backup in each of the last N buckets (UTC), then take the union of all rules.
- **Layout:** each backup is a directory `<dir>/<id>/` with `meta.json` plus one `<source>.gz` per source. It's assembled in `.tmp-*` and renamed into place, and crash leftovers are cleaned up after an hour.
- **Restoring:** `readEntry(id, name)` returns the exact bytes (checked against sha256, throws `BackupIntegrityError` on a mismatch). Use it for downloads or custom restore logic. `restoreFiles(id, { backupFirst: 'before-restore' })` writes the file sources back atomically. Run it inside the app's data lock.
- **SQLite:** don't byte-copy a database that's open for writing. Use a custom source that runs `VACUUM INTO` (or better-sqlite3's `db.backup()`) to a temp file and returns its bytes. To restore, close the connection first.
- **Limits:** backups sit next to the data. They cover app bugs, bad imports and accidental resets, not disk loss. Offer a download for an off-machine copy.

## Develop

```bash
npm test          # vitest
npm run typecheck
npm run build     # regenerates dist/ — commit it (CI checks it's current)
```

Release: bump `version`, `npm run build`, commit, tag `vX.Y.Z`, push the tag.
