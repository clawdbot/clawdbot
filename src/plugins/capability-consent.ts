import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { MANIFEST_KEY } from "../compat/legacy-names.js";
import type {
  PluginAcceptedDeclaredSurface,
  PluginInstallRecord,
} from "../config/types.plugins.js";
import { isRootFileMissingFailure } from "../infra/boundary-file-read.js";
import { resolveRootPathSync } from "../infra/boundary-path.js";
import { readRootJsonObjectSync } from "../infra/json-files.js";
import { detectBundleManifestFormat, loadBundleManifest } from "./bundle-manifest.js";
import { buildPluginCapabilitySummary } from "./capability-summary.js";
import { loadPluginManifest, PLUGIN_MANIFEST_FILENAME } from "./manifest.js";
import { resolvePackageExtensionEntries } from "./package-manifest.js";

const DECLARED_SURFACE_GROUPS = [
  "channels",
  "providers",
  "tools",
  "hooks",
  "mcpServers",
  "cliCommands",
  "cliBackends",
  "skills",
  "dangerousConfigFlags",
] as const satisfies readonly (keyof PluginAcceptedDeclaredSurface)[];

export function mergePluginDeclaredSurfaces(
  surfaces: Iterable<PluginAcceptedDeclaredSurface>,
): PluginAcceptedDeclaredSurface {
  const merged: PluginAcceptedDeclaredSurface = {
    channels: [],
    providers: [],
    tools: [],
    hooks: [],
    mcpServers: [],
    cliCommands: [],
    cliBackends: [],
    skills: [],
    dangerousConfigFlags: [],
  };
  for (const surface of surfaces) {
    for (const group of DECLARED_SURFACE_GROUPS) {
      merged[group].push(...surface[group]);
    }
  }
  for (const group of DECLARED_SURFACE_GROUPS) {
    merged[group] = [...new Set(merged[group])].toSorted();
  }
  return merged;
}

/** Read only validated manifest surfaces belonging to the actual artifact on disk. */
export function resolvePluginArtifactDeclaredSurface(
  rootDir: string,
): PluginAcceptedDeclaredSurface {
  const artifactRoot = fs.realpathSync(rootDir);
  const manifestRoots = new Set<string>();
  const addManifestRoot = (candidateRoot: string): void => {
    if (
      fs.existsSync(path.join(candidateRoot, PLUGIN_MANIFEST_FILENAME)) ||
      detectBundleManifestFormat(candidateRoot)
    ) {
      manifestRoots.add(candidateRoot);
    }
  };
  addManifestRoot(artifactRoot);

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
    const packageMetadata = packageManifest.value[MANIFEST_KEY];
    if (packageMetadata != null && !isRecord(packageMetadata)) {
      throw new Error("package.json openclaw must be an object");
    }
    const rawExtensions = packageMetadata?.extensions;
    if (
      rawExtensions !== undefined &&
      (!Array.isArray(rawExtensions) ||
        !rawExtensions.every((entry): entry is string => typeof entry === "string"))
    ) {
      throw new Error("package.json openclaw.extensions must be an array of strings");
    }
    const extensions = resolvePackageExtensionEntries({
      ...(packageMetadata
        ? {
            [MANIFEST_KEY]: {
              ...(rawExtensions ? { extensions: rawExtensions } : {}),
            },
          }
        : {}),
    });
    if (extensions.status === "invalid") {
      throw new Error(extensions.error);
    }
    for (const entry of extensions.entries) {
      const resolved = resolveRootPathSync({
        absolutePath: path.resolve(artifactRoot, entry),
        rootPath: artifactRoot,
        rootCanonicalPath: artifactRoot,
        boundaryLabel: "plugin artifact directory",
      });
      let candidateRoot =
        resolved.kind === "directory"
          ? resolved.canonicalPath
          : path.dirname(resolved.canonicalPath);
      while (candidateRoot !== artifactRoot) {
        addManifestRoot(candidateRoot);
        candidateRoot = path.dirname(candidateRoot);
      }
    }
  }

  if (manifestRoots.size === 0) {
    throw new Error(`Plugin artifact has no valid plugin manifest: ${artifactRoot}`);
  }
  return mergePluginDeclaredSurfaces(
    Array.from(manifestRoots, (manifestRoot) => {
      const bundleFormat = detectBundleManifestFormat(manifestRoot);
      const loaded = bundleFormat
        ? loadBundleManifest({ rootDir: manifestRoot, bundleFormat })
        : loadPluginManifest(manifestRoot);
      if (!loaded.ok) {
        throw new Error(loaded.error);
      }
      return buildPluginCapabilitySummary({ manifest: loaded.manifest, origin: "global" }).declared;
    }),
  );
}

export function computeDeclaredSurfaceHash(declared: PluginAcceptedDeclaredSurface): string {
  const canonical = Object.fromEntries(
    DECLARED_SURFACE_GROUPS.map((group) => [group, declared[group].toSorted()]),
  );
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function diffDeclaredSurfaceWidening(
  previous: PluginAcceptedDeclaredSurface,
  next: PluginAcceptedDeclaredSurface,
): { widened: Partial<PluginAcceptedDeclaredSurface>; hasWidening: boolean } {
  const widened: Partial<PluginAcceptedDeclaredSurface> = {};
  for (const group of DECLARED_SURFACE_GROUPS) {
    const previousValues = new Set(previous[group]);
    const added = next[group].filter((value) => !previousValues.has(value)).toSorted();
    if (added.length > 0) {
      widened[group] = added;
    }
  }
  return { widened, hasWidening: Object.keys(widened).length > 0 };
}

export function resolvePluginInstallRecordIntegrity(
  record: Pick<PluginInstallRecord, "integrity" | "npmIntegrity" | "clawpackSha256" | "gitCommit">,
): string | undefined {
  return record.integrity ?? record.npmIntegrity ?? record.clawpackSha256 ?? record.gitCommit;
}

export function resolveAcceptedSurfaceCurrent(
  record: PluginInstallRecord,
  declared: PluginAcceptedDeclaredSurface,
): boolean {
  return (
    record.acceptedSurface !== undefined &&
    record.acceptedSurfaceHash !== undefined &&
    record.acceptedSurfaceHash === computeDeclaredSurfaceHash(record.acceptedSurface) &&
    record.acceptedSurfaceHash === computeDeclaredSurfaceHash(declared) &&
    record.acceptedSurfaceIntegrity === resolvePluginInstallRecordIntegrity(record)
  );
}

export function formatPluginCapabilityConsentRequired(pluginId: string): string {
  return `Plugin "${pluginId}" requires capability consent; disable and re-enable it or run \`openclaw plugins enable ${pluginId} --accept-capabilities\`.`;
}
