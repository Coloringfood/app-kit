const registry = (globalThis.__coloringfoodAppKitLocks ??=
    new Map());
export function namedLock(name) {
    return (fn) => {
        const previous = registry.get(name) ?? Promise.resolve();
        const run = previous.then(fn);
        registry.set(name, run.then(() => undefined, () => undefined));
        return run;
    };
}
