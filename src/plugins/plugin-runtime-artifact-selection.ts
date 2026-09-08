/** Selects built plugin artifacts without importing active runtime state. */
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawPackageManifest } from "./manifest.js";
import {
  isTypeScriptPackageEntry,
  listBuiltRuntimeEntryCandidates,
} from "./package-entrypoints.js";
import { getPackageManifestMetadata } from "./package-manifest.js";
import {
  parsePluginCacheJson,
  pluginCacheExistsSync,
  pluginCacheRealpathSync,
  readPluginCacheFile,
} from "./plugin-cache-files.js";
import { getPluginCacheRoot } from "./plugin-cache.js";
import type { PluginOrigin } from "./plugin-origin.types.js";
import type { PluginRecord } from "./registry-types.js";

export type PluginRuntimeArtifactPreference = "source" | "bundled" | "all";
type PluginRuntimeArtifact = { source: string; rootDir: string };
export type PluginRuntimeArtifactSelectionParams = PluginRuntimeArtifact & {
  entryKind: "runtime" | "setup" | "provider-discovery" | "capability-catalog";
  origin: PluginOrigin;
  preferBuiltPluginArtifacts: boolean;
  sourcePreferred?: boolean;
  packageManifest?: OpenClawPackageManifest;
};

const RUNTIME_ARTIFACT_SELECTION = Symbol.for("openclaw.pluginRuntimeArtifactSelection");
type RuntimeArtifactSelection = {
  sourcePreferred: boolean;
  sourceExternal: boolean;
  runtimeEntry: PluginRuntimeArtifact;
  setupEntry?: PluginRuntimeArtifact;
  preferBuiltPluginArtifacts?: boolean;
  runtimeRegistrationComplete: boolean;
};
type ArtifactBoundRecord = PluginRecord & {
  [RUNTIME_ARTIFACT_SELECTION]?: RuntimeArtifactSelection;
};

type RuntimeArtifactSelectionInput = {
  sourcePreferred?: boolean;
  setupSource?: string;
  packageManifest?: OpenClawPackageManifest;
  preferBuiltPluginArtifacts?: boolean;
};

/** Preserve selection inputs on the loaded owner, outside status/protocol serialization. */
export function bindPluginRuntimeArtifactSelection(
  record: PluginRecord,
  params: RuntimeArtifactSelectionInput & {
    runtimeEntry: PluginRuntimeArtifact;
    setupEntry?: PluginRuntimeArtifact;
  },
): RuntimeArtifactSelection {
  const selection = {
    sourcePreferred: params.sourcePreferred === true,
    sourceExternal: params.packageManifest?.build?.bundledDist === false,
    runtimeEntry: params.runtimeEntry,
    setupEntry: params.setupEntry,
    preferBuiltPluginArtifacts: params.preferBuiltPluginArtifacts,
    runtimeRegistrationComplete: false,
  };
  Object.defineProperty(record, RUNTIME_ARTIFACT_SELECTION, { value: selection });
  return selection;
}

export function hasCompletedPluginRuntimeRegistration(record: ArtifactBoundRecord): boolean {
  return (
    record.status === "loaded" &&
    record[RUNTIME_ARTIFACT_SELECTION]?.runtimeRegistrationComplete === true
  );
}

export function matchesPluginRuntimeArtifactSelection(
  record: ArtifactBoundRecord,
  params: RuntimeArtifactSelectionInput & { rootDir: string; source: string },
  preferBuiltPluginArtifacts?: boolean,
): boolean {
  const loaded = record[RUNTIME_ARTIFACT_SELECTION];
  if (
    (loaded?.sourcePreferred === true) !== (params.sourcePreferred === true) ||
    (loaded?.sourceExternal === true) !== (params.packageManifest?.build?.bundledDist === false) ||
    // Bounded reuse keeps an unspecified policy; exact loads compare the full loader key.
    (preferBuiltPluginArtifacts !== undefined &&
      loaded?.preferBuiltPluginArtifacts !== preferBuiltPluginArtifacts)
  ) {
    return false;
  }
  if (!loaded) {
    // Bundle-format records are metadata-only and never select executable artifacts.
    return (
      record.format === "bundle" &&
      record.rootDir === params.rootDir &&
      record.source === params.source
    );
  }
  // Source/build names alone do not prove shared execution. Compare the loader's
  // selected artifacts while retaining the policy that produced this owner.
  const matchesEntry = (
    entry: PluginRuntimeArtifact,
    source: string,
    entryKind: "runtime" | "setup",
  ): boolean => {
    const selected = resolvePluginRuntimeExecutionArtifact(
      resolvePluginRuntimeArtifactSelection({
        ...params,
        source,
        entryKind,
        origin: record.origin,
        preferBuiltPluginArtifacts: loaded.preferBuiltPluginArtifacts === true,
      }),
    );
    return entry.rootDir === selected.rootDir && entry.source === selected.source;
  };
  return (
    matchesEntry(loaded.runtimeEntry, params.source, "runtime") &&
    (!loaded.setupEntry ||
      (params.setupSource !== undefined &&
        matchesEntry(loaded.setupEntry, params.setupSource, "setup")))
  );
}

/** Canonical packaged runtime replaces staging-only dist-runtime artifacts. */
export function resolveCanonicalDistRuntimeSource(source: string): string {
  const marker = `${path.sep}dist-runtime${path.sep}extensions${path.sep}`;
  const index = source.indexOf(marker);
  if (index === -1) {
    return source;
  }
  const candidate = `${source.slice(0, index)}${path.sep}dist${path.sep}extensions${path.sep}${source.slice(index + marker.length)}`;
  return pluginCacheExistsSync(candidate) ? candidate : source;
}

/** Finalize once at execution; discovery and identity retain the selected artifact. */
export function resolvePluginRuntimeExecutionArtifact(
  selected: PluginRuntimeArtifact,
): PluginRuntimeArtifact {
  // This is the loader's existing final pass, not recursive normalization:
  // nested staging paths can make another pass select a different file.
  return {
    source: resolveCanonicalDistRuntimeSource(selected.source),
    rootDir: resolveCanonicalDistRuntimeSource(selected.rootDir),
  };
}

/** Selects from lifecycle-owned package facts without pinning a runtime registry. */
export function resolvePluginRuntimeArtifactSelection(
  params: PluginRuntimeArtifactSelectionParams,
): PluginRuntimeArtifact {
  const rootDir = resolveCanonicalDistRuntimeSource(
    pluginCacheRealpathSync(params.rootDir) ?? path.resolve(params.rootDir),
  );
  const artifacts = getPluginCacheRoot(rootDir).runtimeArtifacts;
  const key = JSON.stringify([
    params.source,
    params.entryKind,
    params.origin,
    params.preferBuiltPluginArtifacts,
    params.sourcePreferred,
    params.packageManifest?.build?.bundledDist,
  ]);
  let resolved = artifacts.get(key);
  if (!resolved) {
    const source = resolveCanonicalDistRuntimeSource(
      pluginCacheRealpathSync(params.source) ?? path.resolve(params.source),
    );
    const preferred = resolvePreferredBuiltRuntimeArtifact({ ...params, source, rootDir });
    resolved = {
      source: resolveCanonicalDistRuntimeSource(preferred.source),
      rootDir: resolveCanonicalDistRuntimeSource(preferred.rootDir),
    };
    artifacts.set(key, resolved);
  }
  return resolved;
}

/** Built hosts default only checkout plugins to compiled execution, not installed packages. */
export function resolvePluginRuntimeArtifactPreference(
  preferBuiltPluginArtifacts?: boolean,
): PluginRuntimeArtifactPreference {
  if (preferBuiltPluginArtifacts !== undefined) {
    return preferBuiltPluginArtifacts ? "all" : "source";
  }
  return /\.[cm]?js$/.test(new URL(import.meta.url).pathname) ? "bundled" : "source";
}

export function prefersBuiltPluginArtifacts(
  preference: PluginRuntimeArtifactPreference,
  origin: PluginOrigin,
): boolean {
  return preference === "all" || (preference === "bundled" && origin === "bundled");
}

function resolveBundledArtifactRelativePath(
  rootDir: string,
  relativeSource: string,
): string | null {
  const file = readPluginCacheFile({
    rootDir,
    relativePath: "package.json",
    rejectHardlinks: false,
  });
  const parsed = file.ok ? parsePluginCacheJson(file) : undefined;
  const metadata =
    parsed?.ok && isRecord(parsed.value) ? getPackageManifestMetadata(parsed.value) : undefined;
  const entries = [
    ...(metadata?.runtimeExtensions?.length
      ? metadata.runtimeExtensions
      : (metadata?.extensions ?? [])),
    metadata?.runtimeSetupEntry ?? metadata?.setupEntry,
  ].filter((entry): entry is string => typeof entry === "string");
  const sourceStem = relativeSource.replace(/\.[^.]+$/u, "");
  const declared = entries.find(
    (entry) => path.normalize(entry).replace(/\.[^.]+$/u, "") === sourceStem,
  );
  if (declared) {
    return /\.[cm]?js$/.test(declared) ? declared : null;
  }
  const extensions = new Set(entries.map((entry) => path.extname(entry)));
  const extension = extensions.size === 1 ? [...extensions][0] : undefined;
  // Emitted metadata owns the format: Docker's unified ESM build can override
  // the standalone CJS preference. Never probe a stale sibling extension.
  if (
    !extension ||
    ![".js", ".mjs", ".cjs"].includes(extension) ||
    entries.some((entry) => path.normalize(entry).startsWith(`dist${path.sep}`))
  ) {
    return null;
  }
  return relativeSource.replace(/\.[^.]+$/u, extension);
}

function resolvePackageLocalDistRuntimeArtifact(params: {
  source: string;
  rootDir: string;
  origin: PluginOrigin;
}): string | null {
  const relativeSource = path.relative(params.rootDir, params.source);
  if (
    !isTypeScriptPackageEntry(relativeSource) ||
    relativeSource === "" ||
    relativeSource.startsWith("..") ||
    path.isAbsolute(relativeSource)
  ) {
    return null;
  }
  for (const artifactRelativePath of listBuiltRuntimeEntryCandidates(relativeSource)) {
    // Bundled source peers must not shadow the canonical root build below.
    if (params.origin === "bundled" && !artifactRelativePath.startsWith("./dist/")) {
      continue;
    }
    const artifactSource = path.resolve(params.rootDir, artifactRelativePath);
    if (pluginCacheExistsSync(artifactSource)) {
      return pluginCacheRealpathSync(artifactSource) ?? path.resolve(artifactSource);
    }
  }
  return null;
}

function resolvePreferredBundledRootArtifactFromCanonicalPaths(params: {
  source: string;
  rootDir: string;
  packageManifest?: OpenClawPackageManifest;
}): { source: string; rootDir: string } {
  const { rootDir, source } = params;
  const sourceExternal = params.packageManifest?.build?.bundledDist === false;
  const extensionsDir = path.dirname(rootDir);
  if (path.basename(extensionsDir) !== "extensions") {
    return { source, rootDir };
  }
  const packageRoot = path.dirname(extensionsDir);
  if (path.basename(packageRoot) === "dist" || path.basename(packageRoot) === "dist-runtime") {
    return { source, rootDir };
  }
  const relativeSource = path.relative(rootDir, source);
  if (relativeSource === "" || relativeSource.startsWith("..") || path.isAbsolute(relativeSource)) {
    return { source, rootDir };
  }
  // Source-external packaging can replace the flat root build while leaving its
  // staging wrapper behind, so only bundled artifacts may fall back to dist-runtime.
  for (const artifactRootName of sourceExternal ? ["dist"] : ["dist-runtime", "dist"]) {
    const artifactRoot = path.join(
      packageRoot,
      artifactRootName,
      "extensions",
      path.basename(rootDir),
    );
    const artifactRelativePath = resolveBundledArtifactRelativePath(artifactRoot, relativeSource);
    if (!artifactRelativePath) {
      continue;
    }
    const artifactSource = path.join(artifactRoot, artifactRelativePath);
    if (pluginCacheExistsSync(artifactSource)) {
      return {
        source: pluginCacheRealpathSync(artifactSource) ?? path.resolve(artifactSource),
        rootDir: pluginCacheRealpathSync(artifactRoot) ?? path.resolve(artifactRoot),
      };
    }
  }
  return { source, rootDir };
}

/** Selects the lifecycle-owned root build for one bundled source artifact. */
export function resolvePreferredBundledRootArtifact(params: {
  source: string;
  rootDir: string;
  packageManifest?: OpenClawPackageManifest;
}): { source: string; rootDir: string } {
  const artifacts = getPluginCacheRoot(params.rootDir).runtimeArtifacts;
  const key = JSON.stringify([
    "bundled-root",
    params.source,
    params.packageManifest?.build?.bundledDist,
  ]);
  const cached = artifacts.get(key);
  if (cached) {
    return cached;
  }
  const resolved = resolvePreferredBundledRootArtifactFromCanonicalPaths({
    source: pluginCacheRealpathSync(params.source) ?? path.resolve(params.source),
    rootDir: pluginCacheRealpathSync(params.rootDir) ?? path.resolve(params.rootDir),
    packageManifest: params.packageManifest,
  });
  artifacts.set(key, resolved);
  return resolved;
}

/** Applies source, package-local, and root-build preference without runtime memo state. */
function resolvePreferredBuiltRuntimeArtifact(params: {
  source: string;
  rootDir: string;
  origin: PluginOrigin;
  preferBuiltPluginArtifacts: boolean;
  sourcePreferred?: boolean;
  packageManifest?: OpenClawPackageManifest;
}): { source: string; rootDir: string } {
  // The stateful resolver canonicalizes both paths before memo-key construction.
  const { rootDir, source } = params;
  if (!params.preferBuiltPluginArtifacts || params.sourcePreferred) {
    return { source, rootDir };
  }
  if (params.origin !== "bundled") {
    const artifactSource = resolvePackageLocalDistRuntimeArtifact({ ...params, source, rootDir });
    return artifactSource ? { source: artifactSource, rootDir } : { source, rootDir };
  }
  // Source-external plugins keep source authoritative over package-local output;
  // only the lifecycle-owned canonical root build may replace that pair.
  const sourceExternal = params.packageManifest?.build?.bundledDist === false;
  const packageLocalArtifactSource = sourceExternal
    ? null
    : resolvePackageLocalDistRuntimeArtifact({ ...params, source, rootDir });
  if (packageLocalArtifactSource) {
    return { source: packageLocalArtifactSource, rootDir };
  }
  return resolvePreferredBundledRootArtifactFromCanonicalPaths({
    source,
    rootDir,
    packageManifest: params.packageManifest,
  });
}
