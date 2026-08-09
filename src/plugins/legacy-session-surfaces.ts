// Resolves plugin-owned legacy session-key behavior from selected setup entries.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { BundledChannelLegacySessionSurface } from "../plugin-sdk/channel-entry-contract.types.js";
import { resolveConfiguredChannelPluginIds } from "./channel-plugin-ids.js";
import {
  EMPTY_LEGACY_SESSION_SURFACES,
  type PreparedLegacySessionSurfaces,
} from "./legacy-session-surfaces.types.js";
import { readLoadedLegacySessionSurfaces } from "./loader-channel-runtime.js";
import { loadPluginRegistryHandle } from "./loader.js";
import {
  buildPluginRuntimeLoadOptions,
  resolvePluginRuntimeLoadContext,
  type PluginRuntimeLoadContext,
} from "./runtime/load-context.js";

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

  let registry: ReturnType<typeof loadPluginRegistryHandle>;
  try {
    registry = loadPluginRegistryHandle(
      buildPluginRuntimeLoadOptions(context, {
        onlyPluginIds: loadableRecords.map((record) => record.id),
        cache: false,
        includeSetupOnlyChannelPlugins: true,
        forceSetupOnlyChannelPlugins: true,
        requireSetupEntryForSetupOnlyChannelPlugins: true,
        channelPluginLoadIntent: "setup",
        loadLegacySessionSurfaces: true,
      }),
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return prepareResult(
      [],
      [...failures, ...loadableRecords.map((record) => formatLoadFailure(record.id, detail))],
    );
  }

  const surfacesByPluginId = new Map(
    readLoadedLegacySessionSurfaces(registry).map((entry) => [entry.pluginId, entry.surface]),
  );
  for (const record of loadableRecords) {
    if (surfacesByPluginId.has(record.id)) {
      continue;
    }
    const detail =
      registry.diagnostics.find(
        (diagnostic) => diagnostic.pluginId === record.id && diagnostic.level === "error",
      )?.message ?? "the setup entry did not return its declared legacy-session sidecar";
    failures.push(formatLoadFailure(record.id, detail));
  }
  return prepareResult(
    loadableRecords.flatMap((record) => {
      const surface = surfacesByPluginId.get(record.id);
      return surface ? [surface] : [];
    }),
    failures,
  );
}
