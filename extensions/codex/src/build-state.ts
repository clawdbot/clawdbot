/**
 * Defines process-wide state that every module copy of one plugin build shares.
 *
 * `Symbol.for` lets duplicate copies of this plugin (dist + src bundles in one
 * process) resolve the same record, so they keep one app-server client table
 * instead of spawning one app-server per copy. The key also carries the record's
 * field set: a plugin update inside a container restarts the gateway in-process,
 * so the next plugin build is a fresh module while `globalThis` is not, and a
 * record written by an older build lacks the fields this build reads.
 */
export function defineCodexBuildState<T extends object>(name: string, create: () => T): () => T {
  const key = Symbol.for(`${name}:${Object.keys(create()).join(",")}`);
  // SAFETY: the key embeds the initializer's field set; a record under it has this shape.
  const globalState = globalThis as Record<symbol, T | undefined>;
  return () => (globalState[key] ??= create());
}
