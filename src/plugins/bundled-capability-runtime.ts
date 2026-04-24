import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { openBoundaryFileSync } from "../infra/boundary-file-read.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  withBundledPluginEnablementCompat,
  withBundledPluginVitestCompat,
} from "./bundled-compat.js";
import { resolveBundledPluginRepoEntryPath } from "./bundled-plugin-metadata.js";
import { createCapturedPluginRegistration } from "./captured-registration.js";
import { discoverOpenClawPlugins } from "./discovery.js";
import { getCachedPluginJitiLoader, type PluginJitiLoaderCache } from "./jiti-loader-cache.js";
import type { PluginLoadOptions } from "./loader.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";
import { unwrapDefaultModuleExport } from "./module-export.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import type { PluginRecord, PluginRegistry } from "./registry.js";
import {
  buildPluginLoaderAliasMap,
  shouldPreferNativeJiti,
  type PluginSdkResolutionPreference,
} from "./sdk-alias.js";
import type { OpenClawPluginDefinition, OpenClawPluginModule } from "./types.js";

const log = createSubsystemLogger("plugins");

const CAPABILITY_VITEST_SHIM_ALIASES = [
  {
    subpath: "llm-task",
    target: new URL("./capability-runtime-vitest-shims/llm-task.ts", import.meta.url),
  },
  {
    subpath: "config-runtime",
    target: new URL("./capability-runtime-vitest-shims/config-runtime.ts", import.meta.url),
  },
  {
    subpath: "media-runtime",
    target: new URL("./capability-runtime-vitest-shims/media-runtime.ts", import.meta.url),
  },
  {
    subpath: "provider-onboard",
    target: new URL("../plugin-sdk/provider-onboard.ts", import.meta.url),
  },
  {
    subpath: "speech-core",
    target: new URL("./capability-runtime-vitest-shims/speech-core.ts", import.meta.url),
  },
] as const;

export function buildVitestCapabilityShimAliasMap(): Record<string, string> {
  return Object.fromEntries(
    CAPABILITY_VITEST_SHIM_ALIASES.flatMap(({ subpath, target }) => {
      const targetPath = fileURLToPath(target);
      return [
        [`openclaw/plugin-sdk/${subpath}`, targetPath],
        [`@openclaw/plugin-sdk/${subpath}`, targetPath],
      ];
    }),
  );
}

function applyVitestCapabilityAliasOverrides(params: {
  aliasMap: Record<string, string>;
  pluginSdkResolution?: PluginSdkResolutionPreference;
  env?: PluginLoadOptions["env"];
}): Record<string, string> {
  if (!params.env?.VITEST || params.pluginSdkResolution !== "dist") {
    return params.aliasMap;
  }

  const {
    "openclaw/plugin-sdk": _ignoredLegacyRootAlias,
    "@openclaw/plugin-sdk": _ignoredScopedRootAlias,
    ...scopedAliasMap
  } = params.aliasMap;
  return {
    ...scopedAliasMap,
    // Capability contract loads only need a narrow SDK slice. Keep those
    // helpers on a tiny source graph so Vitest does not pull the dist chunk
    // bundle that also drags Matrix/WhatsApp code into these tests.
    ...buildVitestCapabilityShimAliasMap(),
  };
}

function shouldApplyVitestCapabilityAliasOverrides(params: {
  pluginSdkResolution?: PluginSdkResolutionPreference;
  env?: PluginLoadOptions["env"];
}): boolean {
  return Boolean(params.env?.VITEST && params.pluginSdkResolution === "dist");
}

export function buildBundledCapabilityRuntimeConfig(
  pluginIds: readonly string[],
  env?: PluginLoadOptions["env"],
): PluginLoadOptions["config"] {
  const enablementCompat = withBundledPluginEnablementCompat({
    config: undefined,
    pluginIds,
  });
  return withBundledPluginVitestCompat({
    config: enablementCompat,
    pluginIds,
    env,
  });
}

function resolvePluginModuleExport(moduleExport: unknown): {
  definition?: OpenClawPluginDefinition;
  register?: OpenClawPluginDefinition["register"];
} {
  const resolved = unwrapDefaultModuleExport(moduleExport);
  if (typeof resolved === "function") {
    return {
      register: resolved as OpenClawPluginDefinition["register"],
    };
  }
  if (resolved && typeof resolved === "object") {
    const definition = resolved as OpenClawPluginDefinition;
    return {
      definition,
      register: definition.register ?? definition.activate,
    };
  }
  return {};
}

function createCapabilityPluginRecord(params: {
  id: string;
  name?: string;
  description?: string;
  version?: string;
  source: string;
  rootDir?: string;
  workspaceDir?: string;
}): PluginRecord {
  return {
    id: params.id,
    name: params.name ?? params.id,
    version: params.version,
    description: params.description,
    source: params.source,
    rootDir: params.rootDir,
    origin: "bundled",
    workspaceDir: params.workspaceDir,
    enabled: true,
    status: "loaded",
    toolNames: [],
    hookNames: [],
    channelIds: [],
    cliBackendIds: [],
    providerIds: [],
    speechProviderIds: [],
    realtimeTranscriptionProviderIds: [],
    realtimeVoiceProviderIds: [],
    mediaUnderstandingProviderIds: [],
    imageGenerationProviderIds: [],
    videoGenerationProviderIds: [],
    musicGenerationProviderIds: [],
    webFetchProviderIds: [],
    webSearchProviderIds: [],
    memoryEmbeddingProviderIds: [],
    agentHarnessIds: [],
    gatewayMethods: [],
    cliCommands: [],
    services: [],
    gatewayDiscoveryServiceIds: [],
    commands: [],
    httpRoutes: 0,
    hookCount: 0,
    configSchema: true,
  };
}

function recordCapabilityLoadError(
  registry: PluginRegistry,
  record: PluginRecord,
  message: string,
): void {
  record.status = "error";
  record.error = message;
  registry.plugins.push(record);
  registry.diagnostics.push({
    level: "error",
    pluginId: record.id,
    source: record.source,
    message: `failed to load plugin: ${message}`,
  });
  log.error(`[plugins] ${record.id} failed to load from ${record.source}: ${message}`);
}

export function loadBundledCapabilityRuntimeRegistry(params: {
  pluginIds: readonly string[];
  env?: PluginLoadOptions["env"];
  pluginSdkResolution?: PluginSdkResolutionPreference;
}) {
  const env = params.env ?? process.env;
  const pluginIds = new Set(params.pluginIds);
  const registry = createEmptyPluginRegistry();
  const jitiLoaders: PluginJitiLoaderCache = new Map();

  const getJiti = (modulePath: string) => {
    const tryNative =
      shouldPreferNativeJiti(modulePath) && !(env?.VITEST && params.pluginSdkResolution === "dist");
    const aliasMap = shouldApplyVitestCapabilityAliasOverrides({
      pluginSdkResolution: params.pluginSdkResolution,
      env,
    })
      ? applyVitestCapabilityAliasOverrides({
          aliasMap: buildPluginLoaderAliasMap(
            modulePath,
            process.argv[1],
            import.meta.url,
            params.pluginSdkResolution,
          ),
          pluginSdkResolution: params.pluginSdkResolution,
          env,
        })
      : undefined;
    return getCachedPluginJitiLoader({
      cache: jitiLoaders,
      modulePath,
      importerUrl: import.meta.url,
      jitiFilename: import.meta.url,
      ...(aliasMap ? { aliasMap } : {}),
      pluginSdkResolution: params.pluginSdkResolution,
      tryNative,
    });
  };

  const discovery = discoverOpenClawPlugins({
    cache: false,
    env,
  });
  const manifestRegistry = loadPluginManifestRegistry({
    config: buildBundledCapabilityRuntimeConfig(params.pluginIds, env),
    cache: false,
    env,
    candidates: discovery.candidates,
    diagnostics: discovery.diagnostics,
  });
  registry.diagnostics.push(...manifestRegistry.diagnostics);

  const manifestByRoot = new Map(
    manifestRegistry.plugins.map((record) => [record.rootDir, record]),
  );
  const seenPluginIds = new Set<string>();
  const repoRoot = process.cwd();

  for (const candidate of discovery.candidates) {
    const manifest = manifestByRoot.get(candidate.rootDir);
    if (!manifest || manifest.origin !== "bundled" || !pluginIds.has(manifest.id)) {
      continue;
    }
    if (seenPluginIds.has(manifest.id)) {
      continue;
    }
    seenPluginIds.add(manifest.id);

    const record = createCapabilityPluginRecord({
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      version: manifest.version,
      source:
        env?.VITEST && params.pluginSdkResolution === "dist"
          ? (resolveBundledPluginRepoEntryPath({
              rootDir: repoRoot,
              pluginId: manifest.id,
              preferBuilt: true,
            }) ?? candidate.source)
          : candidate.source,
      rootDir: candidate.rootDir,
      workspaceDir: candidate.workspaceDir,
    });

    const opened = openBoundaryFileSync({
      absolutePath: record.source,
      rootPath: record.source === candidate.source ? candidate.rootDir : repoRoot,
      boundaryLabel: record.source === candidate.source ? "plugin root" : "repo root",
      rejectHardlinks: false,
      skipLexicalRootCheck: true,
    });
    if (!opened.ok) {
      recordCapabilityLoadError(
        registry,
        record,
        "plugin entry path escapes plugin root or fails alias checks",
      );
      continue;
    }

    const safeSource = opened.path;
    fs.closeSync(opened.fd);

    let mod: OpenClawPluginModule | null = null;
    try {
      mod = getJiti(safeSource)(safeSource) as OpenClawPluginModule;
    } catch (error) {
      recordCapabilityLoadError(registry, record, String(error));
      continue;
    }

    const resolved = resolvePluginModuleExport(mod);
    const register = resolved.register;
    if (typeof register !== "function") {
      record.status = "disabled";
      record.error = "plugin export missing register(api)";
      registry.plugins.push(record);
      continue;
    }

    try {
      const captured = createCapturedPluginRegistration();
      register(captured.api);
      record.cliBackendIds.push(...captured.cliBackends.map((entry) => entry.id));
      record.providerIds.push(...captured.providers.map((entry) => entry.id));
      record.speechProviderIds.push(...captured.speechProviders.map((entry) => entry.id));
      record.realtimeTranscriptionProviderIds.push(
        ...captured.realtimeTranscriptionProviders.map((entry) => entry.id),
      );
      record.realtimeVoiceProviderIds.push(
        ...captured.realtimeVoiceProviders.map((entry) => entry.id),
      );
      record.mediaUnderstandingProviderIds.push(
        ...captured.mediaUnderstandingProviders.map((entry) => entry.id),
      );
      record.imageGenerationProviderIds.push(
        ...captured.imageGenerationProviders.map((entry) => entry.id),
      );
      record.videoGenerationProviderIds.push(
        ...captured.videoGenerationProviders.map((entry) => entry.id),
      );
      record.musicGenerationProviderIds.push(
        ...captured.musicGenerationProviders.map((entry) => entry.id),
      );
      record.webFetchProviderIds.push(...captured.webFetchProviders.map((entry) => entry.id));
      record.webSearchProviderIds.push(...captured.webSearchProviders.map((entry) => entry.id));
      record.memoryEmbeddingProviderIds.push(
        ...captured.memoryEmbeddingProviders.map((entry) => entry.id),
      );
      record.agentHarnessIds.push(...captured.agentHarnesses.map((entry) => entry.id));
      record.toolNames.push(...captured.tools.map((entry) => entry.name));

      registry.cliBackends?.push(
        ...captured.cliBackends.map((backend) => ({
          pluginId: record.id,
          pluginName: record.name,
          backend,
          source: record.source,
          rootDir: record.rootDir,
        })),
      );
      registry.textTransforms.push(
        ...captured.textTransforms.map((transforms) => ({
          pluginId: record.id,
          pluginName: record.name,
          transforms,
          source: record.source,
          rootDir: record.rootDir,
        })),
      );
      registry.providers.push(
        ...captured.providers.map((provider) => ({
          pluginId: record.id,
          pluginName: record.name,
          provider,
          source: record.source,
          rootDir: record.rootDir,
        })),
      );
      registry.speechProviders.push(
        ...captured.speechProviders.map((provider) => ({
          pluginId: record.id,
          pluginName: record.name,
          provider,
          source: record.source,
          rootDir: record.rootDir,
        })),
      );
      registry.realtimeTranscriptionProviders.push(
        ...captured.realtimeTranscriptionProviders.map((provider) => ({
          pluginId: record.id,
          pluginName: record.name,
          provider,
          source: record.source,
          rootDir: record.rootDir,
        })),
      );
      registry.realtimeVoiceProviders.push(
        ...captured.realtimeVoiceProviders.map((provider) => ({
          pluginId: record.id,
          pluginName: record.name,
          provider,
          source: record.source,
          rootDir: record.rootDir,
        })),
      );
      registry.mediaUnderstandingProviders.push(
        ...captured.mediaUnderstandingProviders.map((provider) => ({
          pluginId: record.id,
          pluginName: record.name,
          provider,
          source: record.source,
          rootDir: record.rootDir,
        })),
      );
      registry.imageGenerationProviders.push(
        ...captured.imageGenerationProviders.map((provider) => ({
          pluginId: record.id,
          pluginName: record.name,
          provider,
          source: record.source,
          rootDir: record.rootDir,
        })),
      );
      registry.videoGenerationProviders.push(
        ...captured.videoGenerationProviders.map((provider) => ({
          pluginId: record.id,
          pluginName: record.name,
          provider,
          source: record.source,
          rootDir: record.rootDir,
        })),
      );
      registry.musicGenerationProviders.push(
        ...captured.musicGenerationProviders.map((provider) => ({
          pluginId: record.id,
          pluginName: record.name,
          provider,
          source: record.source,
          rootDir: record.rootDir,
        })),
      );
      registry.webFetchProviders.push(
        ...captured.webFetchProviders.map((provider) => ({
          pluginId: record.id,
          pluginName: record.name,
          provider,
          source: record.source,
          rootDir: record.rootDir,
        })),
      );
      registry.webSearchProviders.push(
        ...captured.webSearchProviders.map((provider) => ({
          pluginId: record.id,
          pluginName: record.name,
          provider,
          source: record.source,
          rootDir: record.rootDir,
        })),
      );
      registry.memoryEmbeddingProviders.push(
        ...captured.memoryEmbeddingProviders.map((provider) => ({
          pluginId: record.id,
          pluginName: record.name,
          provider,
          source: record.source,
          rootDir: record.rootDir,
        })),
      );
      registry.agentHarnesses.push(
        ...captured.agentHarnesses.map((harness) => ({
          pluginId: record.id,
          pluginName: record.name,
          harness,
          source: record.source,
          rootDir: record.rootDir,
        })),
      );
      registry.tools.push(
        ...captured.tools.map((tool) => ({
          pluginId: record.id,
          pluginName: record.name,
          factory: () => tool,
          names: [tool.name],
          optional: false,
          source: record.source,
          rootDir: record.rootDir,
        })),
      );
      registry.plugins.push(record);
    } catch (error) {
      recordCapabilityLoadError(registry, record, String(error));
    }
  }

  return registry;
}
