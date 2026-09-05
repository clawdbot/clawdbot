import codexPluginPackage from "../package.json" with { type: "json" };

/**
 * Duplicate source/dist copies share state only within one published version.
 * In-process Gateway restarts retain old globals; keep those records separate
 * so old disposers still own their clients. Published versions are immutable;
 * local rebuilds without a version bump deliberately share the same record.
 */
export function defineCodexBuildState<T extends object>(name: string, create: () => T): () => T {
  const key = Symbol.for(`${name}@${codexPluginPackage.version}`);
  // SAFETY: the key embeds this plugin build's version; a record under it came from this build's initializer.
  const globalState = globalThis as Record<symbol, T | undefined>;
  return () => (globalState[key] ??= create());
}
