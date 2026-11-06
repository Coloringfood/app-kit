/**
 * In-process mutex keyed by name. Wrap every read-modify-write of a shared file in one, so two
 * concurrent requests can't both read the same snapshot and have the second write drop the first.
 *
 * The queues live on globalThis because Next.js can bundle the same module into several route
 * chunks; a module-level variable would give each chunk its own (useless) lock. Only serializes
 * within one Node process — fine for a single container, not for several replicas.
 */
type Queue = Promise<void>;
const registry = ((globalThis as { __coloringfoodAppKitLocks?: Map<string, Queue> }).__coloringfoodAppKitLocks ??=
  new Map<string, Queue>());

export type Lock = <T>(fn: () => Promise<T>) => Promise<T>;

export function namedLock(name: string): Lock {
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const previous = registry.get(name) ?? Promise.resolve();
    const run = previous.then(fn);
    registry.set(name, run.then(() => undefined, () => undefined));
    return run;
  };
}
