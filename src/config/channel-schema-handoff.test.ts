/**
 * Covers what happens to the generated bundled channel schema when `preferOver` moves a built-in
 * channel to another claimant: the config schema must describe the plugin the runtime activates,
 * so the handoff replaces or removes the generated entry instead of merging into it.
 */
import { describe, expect, it } from "vitest";
import type { PluginManifestRecord, PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { collectChannelSchemaMetadataCore } from "./channel-config-metadata.js";
import { createConfiguredChannelOwnershipPolicy } from "./channel-ownership-policy.js";
import { buildConfigSchemaCore } from "./schema.js";
import type { OpenClawConfig } from "./types.openclaw.js";
import { validateConfigObjectWithPlugins } from "./validation.js";

const CHANNEL_ID = "telegram";
/** A property only the generated bundled Telegram schema declares. */
const GENERATED_ONLY_PROPERTY = "botToken";

function createPluginManifestRecord(
  overrides: Partial<PluginManifestRecord> & Pick<PluginManifestRecord, "id">,
): PluginManifestRecord {
  return {
    channels: [],
    cliBackends: [],
    hooks: [],
    manifestPath: `/tmp/${overrides.id}/openclaw.plugin.json`,
    origin: "bundled",
    providers: [],
    rootDir: `/tmp/${overrides.id}`,
    skills: [],
    source: `/tmp/${overrides.id}/index.js`,
    ...overrides,
  };
}

/** The bundled claimant the generated schema describes. */
function bundledClaimant(): PluginManifestRecord {
  return createPluginManifestRecord({
    id: "telegram",
    origin: "bundled",
    channels: [CHANNEL_ID],
    configSchema: { type: "object", additionalProperties: true },
    channelConfigs: {
      [CHANNEL_ID]: {
        schema: {
          type: "object",
          properties: { [GENERATED_ONLY_PROPERTY]: { type: "string" } },
          additionalProperties: false,
        },
      },
    },
  });
}

function registryWith(replacement: PluginManifestRecord): PluginManifestRegistry {
  return { diagnostics: [], plugins: [bundledClaimant(), replacement] };
}

function channelSchemaFor(
  registry: PluginManifestRegistry,
  config: OpenClawConfig,
  cache = false,
): Record<string, unknown> | undefined {
  const policy = createConfiguredChannelOwnershipPolicy({
    config,
    sourceConfig: config,
    registry,
    env: {},
  });
  const built = buildConfigSchemaCore({
    channels: collectChannelSchemaMetadataCore(registry, policy),
    cache,
  });
  const schema = built.schema as { properties?: Record<string, Record<string, unknown>> };
  const channels = schema.properties?.channels as
    | { properties?: Record<string, Record<string, unknown>> }
    | undefined;
  return channels?.properties?.[CHANNEL_ID];
}

const configuredChannel = {
  agents: { list: [{ id: "main" }] },
  channels: { [CHANNEL_ID]: { plusToken: "abc" } },
} as unknown as OpenClawConfig;

describe("generated channel schema under an ownership handoff", () => {
  // Regression on #128904: the builder starts from GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA
  // and merged the winner's schema into it, so `config.schema` kept advertising the displaced
  // plugin's properties and required fields while validation ran the winner's schema — the
  // Control UI offered fields the winner rejects.
  it("replaces the generated schema with the winner's descriptor", () => {
    const registry = registryWith(
      createPluginManifestRecord({
        id: "telegram-plus",
        origin: "global",
        channels: [CHANNEL_ID],
        configSchema: { type: "object", additionalProperties: true },
        channelConfigs: {
          [CHANNEL_ID]: {
            preferOver: ["telegram"],
            schema: {
              type: "object",
              properties: { plusToken: { type: "string" } },
              additionalProperties: false,
            },
          },
        },
      }),
    );

    const channelSchema = channelSchemaFor(registry, configuredChannel);
    const properties = channelSchema?.properties as Record<string, unknown> | undefined;
    expect(properties).toHaveProperty("plusToken");
    expect(properties).not.toHaveProperty(GENERATED_ONLY_PROPERTY);
    expect(channelSchema?.required ?? []).toEqual([]);
  });

  // The other half of the same finding: a winner that ships no descriptor left the entire
  // generated schema standing for a channel the loader cedes to it.
  it("removes the generated schema when the winner ships no descriptor", () => {
    const registry = registryWith(
      createPluginManifestRecord({
        id: "telegram-plus",
        origin: "global",
        channels: [CHANNEL_ID],
        configSchema: { type: "object", additionalProperties: true },
        channelCatalogMeta: { id: CHANNEL_ID, preferOver: ["telegram"] },
      }),
    );

    expect(channelSchemaFor(registry, configuredChannel)).toBeUndefined();
  });

  // The property the handoff must not spend: with no declared replacement the bundled claimant
  // still owns the channel and its generated schema stays.
  it("keeps the generated schema when no replacement displaces the bundled claimant", () => {
    const registry = registryWith(
      createPluginManifestRecord({
        id: "telegram-plus",
        origin: "global",
        channels: [CHANNEL_ID],
        configSchema: { type: "object", additionalProperties: true },
        channelConfigs: {
          [CHANNEL_ID]: {
            schema: {
              type: "object",
              properties: { plusToken: { type: "string" } },
              additionalProperties: false,
            },
          },
        },
      }),
    );

    const properties = channelSchemaFor(registry, configuredChannel)?.properties as
      | Record<string, unknown>
      | undefined;
    expect(properties).toHaveProperty(GENERATED_ONLY_PROPERTY);
  });

  it("partitions the merged-schema cache by the generated-schema replacement decision", () => {
    const replacement = (preferOver?: string[]) =>
      createPluginManifestRecord({
        id: "telegram-plus-cache",
        origin: "global",
        channels: [CHANNEL_ID],
        configSchema: { type: "object", additionalProperties: true },
        channelConfigs: {
          [CHANNEL_ID]: {
            ...(preferOver ? { preferOver } : {}),
            schema: {
              type: "object",
              properties: { cacheToken: { type: "string" } },
              additionalProperties: false,
            },
          },
        },
      });

    // Origin rank alone selects the same external descriptor but does not replace the generated
    // bundled entry. This primes the cache with both properties under otherwise identical metadata.
    const beforeHandoff = channelSchemaFor(registryWith(replacement()), configuredChannel, true)
      ?.properties as Record<string, unknown> | undefined;
    expect(beforeHandoff).toHaveProperty("cacheToken");
    expect(beforeHandoff).toHaveProperty(GENERATED_ONLY_PROPERTY);

    const afterHandoff = channelSchemaFor(
      registryWith(replacement(["telegram"])),
      configuredChannel,
      true,
    )?.properties as Record<string, unknown> | undefined;
    expect(afterHandoff).toHaveProperty("cacheToken");
    expect(afterHandoff).not.toHaveProperty(GENERATED_ONLY_PROPERTY);
  });

  // `src/config/validation.ts` seeds the same generated metadata and only replaced it when the
  // winner supplied a descriptor, so a descriptorless winner left the operator validated against
  // the strict schema of the plugin its declaration displaced.
  it("does not validate against the generated schema of a displaced claimant", () => {
    const registry = registryWith(
      createPluginManifestRecord({
        id: "telegram-plus",
        origin: "global",
        channels: [CHANNEL_ID],
        configSchema: { type: "object", additionalProperties: true },
        channelCatalogMeta: { id: CHANNEL_ID, preferOver: ["telegram"] },
      }),
    );

    const result = validateConfigObjectWithPlugins(configuredChannel, {
      pluginMetadataSnapshot: { manifestRegistry: registry },
      sourceConfig: configuredChannel,
    });

    expect(
      result.ok
        ? []
        : result.issues.filter((issue) => issue.path.startsWith(`channels.${CHANNEL_ID}`)),
    ).toEqual([]);
  });
});
