// Resolves plugin-owned legacy session-key behavior from selected setup entries.
import fs from "node:fs";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { shouldIncludeChannelSetupFeatureForConfig } from "../channels/plugins/bundled-setup-policy.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { describeRootFileOpenFailure, openRootFileSync } from "../infra/boundary-file-read.js";
import type { BundledChannelLegacySessionSurface } from "../plugin-sdk/channel-entry-contract.types.js";
import { resolveConfiguredChannelPluginIds } from "./channel-plugin-ids.js";
import { normalizePluginsConfig } from "./config-state.js";
import { shouldRejectHardlinkedPluginFiles } from "./hardlink-policy.js";
import {
  EMPTY_LEGACY_SESSION_SURFACES,
  type PreparedLegacySessionSurfaces,
} from "./legacy-session-surfaces.types.js";
import {
  hasExplicitManifestOwnerTrust,
  isActivatedManifestOwner,
  isBundledManifestOwner,
} from "./manifest-owner-policy.js";
import { unwrapDefaultModuleExport } from "./module-export.js";
import { getCachedPluginModuleLoader } from "./plugin-module-loader-cache.js";
import {
  resolveCanonicalDistRuntimeSource,
  resolvePluginRuntimeArtifact,
} from "./plugin-runtime-artifact-resolution.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import {
  resolvePluginRuntimeLoadContext,
  type PluginRuntimeLoadContext,
} from "./runtime/load-context.js";

type LegacySurfaceManifestRecord = NonNullable<
  PluginRuntimeLoadContext["manifestRegistry"]
>["plugins"][number];

function prepareResult(
  surfaces: BundledChannelLegacySessionSurface[],
  failures: string[],
): PreparedLegacySessionSurfaces {
  return Object.freeze({
    surfaces: Object.freeze(surfaces),
    failures: Object.freeze(failures),
  });
}

function formatLoadFailure(pluginId: string, detail: string): string {
  return `Deferred legacy session-key migration for channel owner "${pluginId}": ${detail}. Restore or reinstall the plugin setup entry, then rerun openclaw doctor --fix`;
}

function resolveLegacySessionSurface(moduleExport: unknown): BundledChannelLegacySessionSurface {
  const resolved = unwrapDefaultModuleExport(moduleExport);
  if (!resolved || typeof resolved !== "object") {
    throw new Error("setup entry does not export loadLegacySessionSurface");
  }
  const setupEntry = resolved as { kind?: unknown; loadLegacySessionSurface?: unknown };
  if (
    setupEntry.kind !== "bundled-channel-setup-entry" ||
    typeof setupEntry.loadLegacySessionSurface !== "function"
  ) {
    throw new Error("setup entry does not export loadLegacySessionSurface");
  }
  const surface = setupEntry.loadLegacySessionSurface() as unknown;
  if (!isRecord(surface)) {
    throw new Error("legacy session surface must be an object");
  }
  const isGroupKey = surface.isLegacyGroupSessionKey;
  const canonicalizeKey = surface.canonicalizeLegacySessionKey;
  if (
    (isGroupKey !== undefined && typeof isGroupKey !== "function") ||
    typeof canonicalizeKey !== "function"
  ) {
    throw new Error("legacy session surface must declare canonicalizeLegacySessionKey");
  }
  return surface as BundledChannelLegacySessionSurface;
}

function isEnabledLegacySurfaceOwner(params: {
  record: LegacySurfaceManifestRecord;
  config: OpenClawConfig;
  normalizedConfig: ReturnType<typeof normalizePluginsConfig>;
}): boolean {
  if (
    !shouldIncludeChannelSetupFeatureForConfig({
      plugin: params.record,
      config: params.config,
    })
  ) {
    return false;
  }
  if (isBundledManifestOwner(params.record)) {
    return true;
  }
  if (params.record.origin === "global" || params.record.origin === "config") {
    return hasExplicitManifestOwnerTrust({
      plugin: params.record,
      normalizedConfig: params.normalizedConfig,
    });
  }
  return isActivatedManifestOwner({
    plugin: params.record,
    normalizedConfig: params.normalizedConfig,
    rootConfig: params.config,
  });
}

function loadLegacySessionSurface(params: {
  record: LegacySurfaceManifestRecord & { setupSource: string };
  env: NodeJS.ProcessEnv;
  artifactRegistry: ReturnType<typeof createEmptyPluginRegistry>;
}): BundledChannelLegacySessionSurface {
  const setupEntry = resolvePluginRuntimeArtifact({
    pluginId: params.record.id,
    entryKind: "setup",
    source: params.record.setupSource,
    rootDir: params.record.rootDir,
    origin: params.record.origin,
    preferBuiltPluginArtifacts: false,
    packageManifest: params.record.packageManifest,
    registry: params.artifactRegistry,
  });
  const moduleSource = resolveCanonicalDistRuntimeSource(setupEntry.source);
  const moduleRoot = resolveCanonicalDistRuntimeSource(setupEntry.rootDir);
  const opened = openRootFileSync({
    absolutePath: moduleSource,
    rootPath: moduleRoot,
    boundaryLabel: "plugin root",
    rejectHardlinks: shouldRejectHardlinkedPluginFiles({
      origin: params.record.origin,
      rootDir: params.record.rootDir,
      env: params.env,
    }),
    skipLexicalRootCheck: true,
  });
  if (!opened.ok) {
    throw new Error(
      describeRootFileOpenFailure({
        failure: opened,
        subject: "plugin setup entry path",
        boundaryLabel: "plugin root",
        filePath: moduleSource,
      }),
    );
  }
  const safeSource = opened.path;
  fs.closeSync(opened.fd);
  const moduleExport = getCachedPluginModuleLoader({
    modulePath: safeSource,
    rootDir: moduleRoot,
    importerUrl: import.meta.url,
    loaderFilename: import.meta.url,
  })(safeSource);
  return resolveLegacySessionSurface(moduleExport);
}

/** Resolves immutable session surfaces from the exact configured channel-owner snapshot. */
export function prepareLegacySessionSurfaces(params: {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  context?: PluginRuntimeLoadContext;
}): PreparedLegacySessionSurfaces {
  const context =
    params.context ??
    resolvePluginRuntimeLoadContext({
      config: params.config,
      env: params.env,
    });
  const manifestRecords = context.manifestRegistry?.plugins ?? [];
  const selectedPluginIds = new Set(
    resolveConfiguredChannelPluginIds({
      config: context.config,
      activationSourceConfig: context.activationSourceConfig,
      workspaceDir: context.workspaceDir,
      env: context.env,
      manifestRecords,
    }),
  );
  const normalizedConfig = normalizePluginsConfig(context.activationSourceConfig.plugins);
  for (const record of manifestRecords) {
    if (
      record.packageManifest?.setupFeatures?.legacySessionSurfaces === true &&
      isEnabledLegacySurfaceOwner({
        record,
        config: context.activationSourceConfig,
        normalizedConfig,
      })
    ) {
      selectedPluginIds.add(record.id);
    }
  }
  const declaringRecords = manifestRecords.filter(
    (record) =>
      selectedPluginIds.has(record.id) &&
      record.packageManifest?.setupFeatures?.legacySessionSurfaces === true,
  );
  if (declaringRecords.length === 0) {
    return EMPTY_LEGACY_SESSION_SURFACES;
  }

  const failures = declaringRecords.flatMap((record) =>
    record.setupSource
      ? []
      : [
          formatLoadFailure(
            record.id,
            "package metadata declares the surface but has no setupEntry",
          ),
        ],
  );
  const loadableRecords = declaringRecords.filter((record) => Boolean(record.setupSource));
  if (loadableRecords.length === 0) {
    return prepareResult([], failures);
  }

  const surfaces: BundledChannelLegacySessionSurface[] = [];
  const artifactRegistry = createEmptyPluginRegistry();
  for (const record of loadableRecords) {
    try {
      surfaces.push(
        loadLegacySessionSurface({
          record: record as LegacySurfaceManifestRecord & { setupSource: string },
          env: context.env,
          artifactRegistry,
        }),
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      failures.push(formatLoadFailure(record.id, detail));
    }
  }
  return prepareResult(surfaces, failures);
}
