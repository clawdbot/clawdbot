import codexPluginPackage from "../package.json" with { type: "json" };

/**
 * Duplicate module copies share one immutable published version's state.
 * In-process restarts retain old records and callbacks for their old owners.
 * Local rebuilds without a version bump deliberately share the same state.
 */
export function codexBuildSymbol(name: string): symbol {
  return Symbol.for(`${name}@${codexPluginPackage.version}`);
}

export function defineCodexBuildState<T extends object>(name: string, create: () => T): () => T {
  const key = codexBuildSymbol(name);
  // SAFETY: the key embeds this plugin build's version; a record under it came from this build's initializer.
  const globalState = globalThis as Record<symbol, T | undefined>;
  return () => (globalState[key] ??= create());
}
