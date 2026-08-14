import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { EmbeddingProviderStartupInspector } from "./embedding-provider-types.js";
import { collectConfiguredMemoryEmbeddingStartupProviderOwners } from "./gateway-startup-plugin-providers.js";
import type { PluginManifestRegistry } from "./manifest-registry.js";
import { loadPluginManifestRegistryForPluginRegistry } from "./plugin-registry.js";
import {
  loadBundledPluginPublicArtifactModuleSync,
  loadPluginPublicArtifactModuleSync,
} from "./public-surface-loader.js";

type EmbeddingProviderPreflightArtifact = {
  embeddingProviderStartupInspectors?: unknown;
};

function isStartupInspector(value: unknown): value is EmbeddingProviderStartupInspector {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<EmbeddingProviderStartupInspector>;
  return (
    typeof candidate.id === "string" &&
    candidate.id.trim().length > 0 &&
    typeof candidate.inspectStartupPrerequisites === "function"
  );
}

function loadStartupInspectors(
  plugin: PluginManifestRegistry["plugins"][number],
): EmbeddingProviderStartupInspector[] {
  let mod: EmbeddingProviderPreflightArtifact;
  try {
    mod =
      plugin.origin === "bundled"
        ? loadBundledPluginPublicArtifactModuleSync<EmbeddingProviderPreflightArtifact>({
            dirName: plugin.id,
            artifactBasename: "embedding-provider-preflight-api.js",
          })
        : loadPluginPublicArtifactModuleSync<EmbeddingProviderPreflightArtifact>({
            pluginRoot: plugin.rootDir,
            artifactBasename: "embedding-provider-preflight-api.js",
          });
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.startsWith("Unable to resolve bundled plugin public surface ") ||
        error.message.startsWith("Unable to resolve plugin public surface "))
    ) {
      return [];
    }
    throw error;
  }
  return Array.isArray(mod.embeddingProviderStartupInspectors)
    ? mod.embeddingProviderStartupInspectors.filter(isStartupInspector)
    : [];
}

export function resolveMemoryEmbeddingProviderStartupInspector(params: {
  providerId: string;
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
}): EmbeddingProviderStartupInspector | undefined {
  const normalizedProviderId = normalizeProviderId(params.providerId);
  if (!normalizedProviderId) {
    return undefined;
  }
  const configuredOwner = collectConfiguredMemoryEmbeddingStartupProviderOwners(params.config).find(
    (entry) => entry.configuredId === normalizedProviderId,
  );
  const ownerIds = configuredOwner?.ownerIds ?? new Set([normalizedProviderId]);
  const registry =
    params.manifestRegistry ??
    loadPluginManifestRegistryForPluginRegistry({
      config: params.config,
      env: params.env,
      includeDisabled: true,
    });
  const owners = registry.plugins.filter((plugin) =>
    [
      ...(plugin.contracts?.embeddingProviders ?? []),
      ...(plugin.contracts?.memoryEmbeddingProviders ?? []),
    ]
      .map(normalizeProviderId)
      .some((providerId) => ownerIds.has(providerId)),
  );
  if (
    owners.length !== 1 ||
    (owners[0]?.origin !== "bundled" && owners[0]?.trustedOfficialInstall !== true)
  ) {
    return undefined;
  }
  const owner = owners[0];
  return loadStartupInspectors(owner).find((inspector) =>
    ownerIds.has(normalizeProviderId(inspector.id)),
  );
}
