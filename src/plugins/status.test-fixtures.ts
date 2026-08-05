/** Test-only plugin status and registry fixture builders. */
import { createEmptyPluginRegistry } from "./registry-empty.js";
import type { PluginRecord, PluginRegistry } from "./registry.js";
import type { PluginCompatibilityNotice } from "./status.js";
import { createPluginRecord } from "./status.test-helpers.js";
import type { PluginHookName } from "./types.js";

export { createPluginRecord };

export const HOOK_ONLY_MESSAGE =
  "is hook-only. This remains a supported compatibility path, but it has not migrated to explicit capability registration yet.";
export const DEPRECATED_MEMORY_EMBEDDING_PROVIDER_API_MESSAGE =
  "uses deprecated memory-specific embedding provider API; use api.registerEmbeddingProvider and contracts.embeddingProviders for new embedding providers.";
export const REMOVED_SESSION_TRANSCRIPT_FILE_API_MESSAGE =
  "references removed session/transcript file APIs; migrate to session identity, SessionTranscriptUpdate.target, and Gateway/runtime session helpers.";

export function createCompatibilityNotice(
  params: Pick<PluginCompatibilityNotice, "pluginId" | "code">,
): PluginCompatibilityNotice {
  switch (params.code) {
    case "hook-only":
      return {
        pluginId: params.pluginId,
        code: params.code,
        compatCode: "hook-only-plugin-shape",
        severity: "info",
        message: HOOK_ONLY_MESSAGE,
      };
    case "deprecated-memory-embedding-provider-api":
      return {
        pluginId: params.pluginId,
        code: params.code,
        compatCode: "deprecated-memory-embedding-provider-api",
        severity: "warn",
        message: DEPRECATED_MEMORY_EMBEDDING_PROVIDER_API_MESSAGE,
      };
    case "removed-session-transcript-file-api":
      return {
        pluginId: params.pluginId,
        code: params.code,
        compatCode: "removed-session-transcript-file-api",
        severity: "warn",
        message: REMOVED_SESSION_TRANSCRIPT_FILE_API_MESSAGE,
      };
  }
  throw new Error("Unsupported compatibility notice code");
}

export function createBundledPluginRecord(id: string): PluginRecord {
  return createPluginRecord({
    id,
    source: `bundled:${id}`,
    rootDir: `/bundled/${id}`,
    origin: "bundled",
  });
}

export function createTypedHook(params: {
  pluginId: string;
  hookName: PluginHookName;
  source?: string;
}): PluginRegistry["typedHooks"][number] {
  return {
    pluginId: params.pluginId,
    hookName: params.hookName,
    handler: () => undefined,
    source: params.source ?? `/tmp/${params.pluginId}/index.ts`,
  };
}

export function createCustomHook(params: {
  pluginId: string;
  events: string[];
  name?: string;
}): PluginRegistry["hooks"][number] {
  const source = `/tmp/${params.pluginId}/handler.ts`;
  return {
    pluginId: params.pluginId,
    events: params.events,
    source,
    entry: {
      hook: {
        name: params.name ?? "legacy",
        description: "",
        source: "openclaw-plugin",
        pluginId: params.pluginId,
        filePath: `/tmp/${params.pluginId}/HOOK.md`,
        baseDir: `/tmp/${params.pluginId}`,
        handlerPath: source,
      },
      frontmatter: {},
    },
  };
}

export function createPluginLoadResult(
  overrides: Partial<PluginRegistry> & Pick<PluginRegistry, "plugins"> = { plugins: [] },
): PluginRegistry {
  const registry = createEmptyPluginRegistry();
  for (const key of Object.keys(overrides) as Array<keyof PluginRegistry>) {
    const value = overrides[key];
    if (value !== undefined) {
      Object.assign(registry, { [key]: value });
    }
  }
  return registry;
}
