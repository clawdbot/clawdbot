import codexPluginPackage from "../package.json" with { type: "json" };

/**
 * Defines process-wide state that every module copy of one plugin build shares.
 *
 * `Symbol.for` lets duplicate copies of this plugin (dist + src bundles in one
 * process) resolve the same record, so they keep one app-server client table
 * instead of spawning one app-server per copy. The key carries the plugin
 * version: a plugin update inside a container restarts the gateway in-process,
 * so the next build is a fresh module while `globalThis` is not, and a record
 * written by another version need not match the shape this build reads. Copies
 * with one version run one published build; a locally patched build without a
 * version bump shares the record and owns that risk.
 */
export function defineCodexBuildState<T extends object>(name: string, create: () => T): () => T {
  const key = Symbol.for(`${name}@${codexPluginPackage.version}`);
  // SAFETY: the key embeds this plugin build's version; a record under it came from this build's initializer.
  const globalState = globalThis as Record<symbol, T | undefined>;
  return () => (globalState[key] ??= create());
}
