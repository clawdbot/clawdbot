import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginAcceptedDeclaredSurface } from "../config/types.plugins.js";
import { isRootFileMissingFailure } from "../infra/boundary-file-read.js";
import {
  resolvePathViaExistingAncestorSync,
  resolveRootPathSync,
  safeRealpathSync,
} from "../infra/boundary-path.js";
import { readRootJsonObjectSync } from "../infra/json-files.js";
import { isPathInside } from "../infra/path-guards.js";
import { resolveUserPath } from "../utils.js";
import { buildPluginCapabilitySummary, mergePluginDeclaredSurfaces } from "./capability-summary.js";
import { discoverConfiguredPluginLoadPaths } from "./discovery.js";
import { loadPluginManifestRegistryCore } from "./manifest-registry.js";
import { resolvePackageExtensionEntries } from "./package-manifest.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";

type PluginArtifactInspectionContext = {
  config?: OpenClawConfig;
  currentArtifactDir?: string;
};

function resolvePluginArtifactManifests(
  rootDir: string,
  env: NodeJS.ProcessEnv = process.env,
  context: PluginArtifactInspectionContext = {},
) {
  const artifactRoot = fs.realpathSync(resolveUserPath(rootDir, env));
  const packageManifest = readRootJsonObjectSync({
    rootDir: artifactRoot,
    rootRealPath: artifactRoot,
    relativePath: "package.json",
    boundaryLabel: "plugin artifact directory",
    rejectHardlinks: true,
  });
  if (!packageManifest.ok) {
    if (packageManifest.reason !== "open" || !isRootFileMissingFailure(packageManifest.failure)) {
      throw new Error(`Unable to inspect the plugin artifact package manifest: ${artifactRoot}`);
    }
  } else {
    const extensions = resolvePackageExtensionEntries(packageManifest.value);
    if (extensions.status === "invalid") {
      throw new Error(extensions.error);
    }
    if (extensions.status === "empty") {
      throw new Error("package.json openclaw.extensions is empty");
    }
  }

  const currentRoot = path.resolve(resolveUserPath(context.currentArtifactDir ?? rootDir, env));
  const currentCanonicalRoot = resolvePathViaExistingAncestorSync(currentRoot);
  const loadPaths: string[] = [];
  for (const configuredPath of context.config?.plugins?.load?.paths ?? []) {
    const source = path.resolve(resolveUserPath(configuredPath, env));
    const canonicalSource = resolvePathViaExistingAncestorSync(source);
    if (
      !isPathInside(currentRoot, source) &&
      !isPathInside(currentCanonicalRoot, canonicalSource)
    ) {
      continue;
    }
    const current = resolveRootPathSync({
      absolutePath: source,
      rootPath: currentRoot,
      rootCanonicalPath: currentCanonicalRoot,
      boundaryLabel: "installed plugin artifact directory",
    });
    const lexicalRoot = isPathInside(currentRoot, source) ? currentRoot : currentCanonicalRoot;
    const relativePath = isPathInside(lexicalRoot, source)
      ? path.relative(lexicalRoot, source)
      : path.relative(
          currentCanonicalRoot,
          current.kind === "directory"
            ? current.canonicalPath
            : path.join(
                resolvePathViaExistingAncestorSync(path.dirname(source)),
                path.basename(source),
              ),
        );
    const staged = resolveRootPathSync({
      absolutePath: path.join(artifactRoot, relativePath),
      rootPath: artifactRoot,
      rootCanonicalPath: artifactRoot,
      boundaryLabel: "staged plugin artifact directory",
    });
    // A file symlink uses its lexical parent's manifest, not the target file's parent.
    loadPaths.push(staged.absolutePath);
  }
  // Explicit paths keep runtime precedence; ordinary package entries all use their root manifest.
  loadPaths.push(artifactRoot);
  const packageDiscovery = discoverConfiguredPluginLoadPaths({
    loadPaths: [artifactRoot],
    env,
    deduplicate: true,
  });
  const packageSources = new Set(
    packageDiscovery.candidates.map(
      (candidate) => safeRealpathSync(candidate.source) ?? candidate.source,
    ),
  );
  const discovery =
    loadPaths.length === 1
      ? packageDiscovery
      : discoverConfiguredPluginLoadPaths({ loadPaths, env, deduplicate: true });
  const registry = loadPluginManifestRegistryCore({
    config: { plugins: { load: { paths: loadPaths } } },
    env,
    installRecords: {},
    discovery: {
      // Only physical package entries inherit managed ownership, including configured overrides.
      candidates: discovery.candidates.filter((candidate) =>
        packageSources.has(safeRealpathSync(candidate.source) ?? candidate.source),
      ),
      diagnostics: packageDiscovery.diagnostics,
    },
  });
  const error = registry.diagnostics.find((diagnostic) => diagnostic.level === "error");
  if (error || registry.plugins.length === 0) {
    throw new Error(
      error?.message ?? `Plugin artifact has no valid plugin manifest: ${artifactRoot}`,
    );
  }
  return registry.plugins;
}

export function inspectPluginCapabilityArtifact(
  rootDir: string,
  env: NodeJS.ProcessEnv = process.env,
  context: PluginArtifactInspectionContext = {},
) {
  // Consent inspects the current artifact, including after an approval callback yields.
  // Runtime or earlier review facts must never authorize replacement bytes.
  return withPluginCache(createPluginCache(), () => {
    const manifests = resolvePluginArtifactManifests(rootDir, env, context);
    return {
      manifest: manifests[0],
      declared: mergePluginDeclaredSurfaces(
        manifests.map(
          (manifest) => buildPluginCapabilitySummary({ manifest, origin: "global" }).declared,
        ),
      ),
    };
  });
}

/** Read only validated manifest surfaces belonging to the actual artifact on disk. */
export function resolvePluginArtifactDeclaredSurface(
  rootDir: string,
  env: NodeJS.ProcessEnv = process.env,
  context: PluginArtifactInspectionContext = {},
): PluginAcceptedDeclaredSurface {
  return inspectPluginCapabilityArtifact(rootDir, env, context).declared;
}
