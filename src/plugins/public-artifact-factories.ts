import { loadBundledPluginPublicArtifactModuleFromCandidatesSync } from "./public-surface-loader.js";

/** Factory order is observable when plugins initialize and when their entries are consumed. */
export function collectPublicArtifactFactories<T>(params: {
  mod: Record<string, unknown>;
  suffix: string;
  isArtifact: (value: unknown) => value is T;
  onFactoryError?: (error: unknown) => void;
}): T[] {
  const artifacts: T[] = [];
  for (const [name, exported] of Object.entries(params.mod).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (
      typeof exported !== "function" ||
      exported.length !== 0 ||
      !name.startsWith("create") ||
      !name.endsWith(params.suffix)
    ) {
      continue;
    }
    let candidate: unknown;
    try {
      candidate = exported();
    } catch (error) {
      if (!params.onFactoryError) {
        throw error;
      }
      params.onFactoryError(error);
      continue;
    }
    if (params.isArtifact(candidate)) {
      artifacts.push(candidate);
    }
  }
  return artifacts;
}

/** Loads a typed artifact surface without activating the plugin's runtime entry. */
export function loadBundledPublicArtifactEntries<T extends object>(params: {
  dirName: string;
  pluginId: string;
  artifactCandidates: readonly string[];
  suffix: string;
  isArtifact: (value: unknown) => value is T;
  partialFailureLabel?: string;
}): Array<T & { pluginId: string }> | null {
  const mod = loadBundledPluginPublicArtifactModuleFromCandidatesSync<Record<string, unknown>>({
    dirName: params.dirName,
    artifactCandidates: params.artifactCandidates,
  });
  if (!mod) {
    return null;
  }
  const errors: unknown[] = [];
  const artifacts = collectPublicArtifactFactories({
    mod,
    suffix: params.suffix,
    isArtifact: params.isArtifact,
    // Only document and web providers tolerate failed siblings. Other surfaces fail immediately.
    onFactoryError: params.partialFailureLabel ? (error) => errors.push(error) : undefined,
  });
  if (artifacts.length === 0) {
    if (errors.length > 0) {
      throw new Error(
        `Unable to initialize ${params.partialFailureLabel} for plugin ${params.pluginId}`,
        { cause: errors.length === 1 ? errors[0] : new AggregateError(errors) },
      );
    }
    return null;
  }
  return artifacts.map((artifact) => Object.assign({}, artifact, { pluginId: params.pluginId }));
}
