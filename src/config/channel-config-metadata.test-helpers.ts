// Shared fixtures for the channel config schema ownership test suites.
import type { PluginManifestRecord, PluginManifestRegistry } from "../plugins/manifest-registry.js";
import type { PluginConfigUiHint } from "../plugins/manifest-types.js";
import type { PluginOrigin } from "../plugins/plugin-origin.types.js";
import { collectChannelSchemaMetadataWithOwnership } from "./channel-config-metadata.js";
import { makeIsolatedEnv } from "./plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "./types.js";
import { validateConfigObjectWithPlugins } from "./validation.js";

export function createChannelPlugin(params: {
  id: string;
  origin: PluginOrigin;
  channelId?: string;
  extraProperty?: string;
  preferOver?: string[];
  enabledByDefault?: boolean;
  label?: string;
  description?: string;
  omitSchema?: boolean;
  uiHints?: Record<string, PluginConfigUiHint>;
  // Catalog metadata can merge a channelConfigs entry for a channel the manifest `channels`
  // list never claims, so tests can decouple the claim from the declaration.
  claimChannels?: string[];
}): PluginManifestRecord {
  const channelId = params.channelId ?? "slack";
  return {
    id: params.id,
    channels: params.claimChannels ?? [channelId],
    ...(params.enabledByDefault ? { enabledByDefault: true } : {}),
    configSchema: {
      type: "object",
      properties: { workspace: { type: "string" } },
      additionalProperties: false,
    },
    channelConfigs: {
      [channelId]: {
        ...(params.preferOver ? { preferOver: params.preferOver } : {}),
        ...(params.label ? { label: params.label } : {}),
        ...(params.description ? { description: params.description } : {}),
        ...(params.uiHints ? { uiHints: params.uiHints } : {}),
        // `undefined as never` mirrors the presentation-only channel declarations the repo's
        // channel-metadata fixtures already carry: the manifest type requires `schema`, but the
        // collector must keep behaving like current main when a claim supplies none.
        schema: params.omitSchema
          ? (undefined as never)
          : {
              type: "object",
              properties: {
                mode: { type: "string" },
                ...(params.extraProperty ? { [params.extraProperty]: { type: "object" } } : {}),
              },
              additionalProperties: false,
            },
      },
    },
    cliBackends: [],
    hooks: [],
    manifestPath: `/tmp/${params.id}/openclaw.plugin.json`,
    origin: params.origin,
    providers: [],
    rootDir: `/tmp/${params.id}`,
    skills: [],
    source: `/tmp/${params.id}/index.js`,
  };
}

// Plugin-owned channel id so the assertion covers collected plugin schemas only, without the
// bundled channel Zod refinements that run before manifest-backed channel schema validation.
export const REPLACED_ACME = createChannelPlugin({
  id: "openclaw-acmechat",
  origin: "global",
  channelId: "acmechat",
  extraProperty: "legacyOption",
});
export const REPLACEMENT_ACME = createChannelPlugin({
  id: "acme-chat-thread-guard",
  origin: "global",
  channelId: "acmechat",
  extraProperty: "threadGuard",
  preferOver: ["openclaw-acmechat"],
});

export function selectAcmeOwner(
  channelId: string,
  plugins: PluginManifestRecord[],
  config: OpenClawConfig,
): string | undefined {
  const registry: PluginManifestRegistry = { diagnostics: [], plugins };
  return collectChannelSchemaMetadataWithOwnership(registry, config, makeIsolatedEnv()).find(
    (channel) => channel.id === channelId,
  )?.schemaPluginId;
}

export function validateAcmeChatKeys(params: {
  plugins: PluginManifestRecord[];
  channel: Record<string, unknown>;
  entries: Record<string, Record<string, unknown>>;
  deny?: readonly string[];
}) {
  const result = validateConfigObjectWithPlugins(
    {
      agents: { list: [{ id: "openclaw" }] },
      channels: { acmechat: params.channel },
      plugins: { entries: params.entries, ...(params.deny ? { deny: [...params.deny] } : {}) },
    },
    {
      env: makeIsolatedEnv(),
      pluginMetadataSnapshot: {
        manifestRegistry: { diagnostics: [], plugins: params.plugins },
      },
    },
  );
  return result.ok ? [] : result.issues;
}
