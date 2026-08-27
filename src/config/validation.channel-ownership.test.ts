// Verifies validation reads channel schema ownership from the authored sourceConfig.

import { describe, expect, it } from "vitest";
import { listBundledChannelCatalogEntries } from "../channels/bundled-channel-catalog-read.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA } from "./bundled-channel-config-metadata.generated.js";
import { normalizeChannelMetadataKey } from "./channel-config-metadata.js";
import type { OpenClawConfig } from "./types.openclaw.js";
import {
  validateConfigObjectRawWithPlugins,
  validateConfigObjectWithPlugins,
} from "./validation.js";

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

describe("validateConfigObjectWithPlugins channel schema ownership sourceConfig", () => {
  // Codex P1 3846202592: validation built the channel ownership policy from the config under
  // validation alone. On the config.patch flow that object is runtime-shaped — it already carries
  // the `plugins.entries.<id>.config` records validation itself seeded on the previous pass — and
  // explicit selection counts any entry with a `config` record, so both claimants read as
  // hand-picked, the replacement's `preferOver` edge was set aside, and the first registrant's
  // strict schema rejected a field only the replacement accepts while startup serves the
  // replacement. The authored half must come from `sourceConfig` when the caller has one.
  function createVoxchatReplacementSnapshot(): {
    manifestRegistry: PluginManifestRegistry;
  } {
    return {
      manifestRegistry: {
        diagnostics: [],
        plugins: [
          // First registrant: registration order hands it the contested channel unless the
          // replacement's `preferOver` edge displaces it.
          createPluginManifestRecord({
            id: "voxchat-classic",
            origin: "global",
            channels: ["voxchat"],
            // Seeded entry configs must validate against something, like real claimants that
            // declare a plugin config schema.
            configSchema: { type: "object", additionalProperties: true },
            channelConfigs: {
              voxchat: {
                schema: {
                  type: "object",
                  properties: { botToken: { type: "string" } },
                  additionalProperties: false,
                },
              },
            },
          }),
          createPluginManifestRecord({
            id: "voxchat-next",
            origin: "global",
            channels: ["voxchat"],
            configSchema: { type: "object", additionalProperties: true },
            channelConfigs: {
              voxchat: {
                schema: {
                  type: "object",
                  properties: {
                    botToken: { type: "string" },
                    // The discriminating field: only the replacement's schema has it.
                    replyMode: { type: "string", enum: ["thread", "direct"] },
                  },
                  additionalProperties: false,
                },
                preferOver: ["voxchat-classic"],
              },
            },
          }),
        ],
      },
    };
  }

  // Runtime-shaped candidate as config.patch validates it: the previous validation pass seeded an
  // entry config for every enabled claimant, and an empty record is what a schema with no
  // defaults seeds.
  const runtimeShapedCandidate = {
    channels: { voxchat: { botToken: "tok", replyMode: "thread" } },
    plugins: {
      entries: { "voxchat-classic": { config: {} }, "voxchat-next": { config: {} } },
    },
  };
  // Authored counterpart: the operator configured the channel and hand-picked nothing.
  const authoredCandidate = {
    channels: { voxchat: { botToken: "tok", replyMode: "thread" } },
    plugins: {},
  } as OpenClawConfig;

  it("validates against the replacement's schema when the authored sourceConfig is supplied", () => {
    const result = validateConfigObjectWithPlugins(runtimeShapedCandidate, {
      pluginMetadataSnapshot: createVoxchatReplacementSnapshot(),
      sourceConfig: authoredCandidate,
    });

    expect(result.ok).toBe(true);
  });

  it("threads the authored half through raw validation too", () => {
    const result = validateConfigObjectRawWithPlugins(runtimeShapedCandidate, {
      pluginMetadataSnapshot: createVoxchatReplacementSnapshot(),
      sourceConfig: authoredCandidate,
    });

    expect(result.ok).toBe(true);
  });

  // The default without `sourceConfig` is the pre-materialization parse of the input itself,
  // which is correct exactly when the input is authored: an operator who really wrote those
  // material entries hand-picked both claimants, the edge is set aside, and the first
  // registrant's strict schema properly rejects the replacement-only field.
  it("keeps reading authored material entries as selection when no sourceConfig is passed", () => {
    const result = validateConfigObjectWithPlugins(runtimeShapedCandidate, {
      pluginMetadataSnapshot: createVoxchatReplacementSnapshot(),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual(
        expect.objectContaining({ path: expect.stringContaining("channels.voxchat") }),
      );
    }
  });

  it("validates an authored-case custom channel against its canonical metadata schema", () => {
    const manifestRegistry: PluginManifestRegistry = {
      diagnostics: [],
      plugins: [
        createPluginManifestRecord({
          id: "acme-chat",
          origin: "global",
          channels: ["AcmeChat"],
          channelConfigs: {
            AcmeChat: {
              schema: {
                type: "object",
                properties: { endpoint: { type: "string" } },
                required: ["endpoint"],
                additionalProperties: false,
              },
            },
          },
        }),
      ],
    };

    const result = validateConfigObjectRawWithPlugins(
      { channels: { AcmeChat: { endpoint: 42 } } },
      { pluginMetadataSnapshot: { manifestRegistry } },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual(
        expect.objectContaining({ path: "channels.AcmeChat.endpoint" }),
      );
    }
  });

  it.each([{ declaredChannelId: "wechat", authoredChannelId: "wechat" }])(
    "validates runtime-catalog alias $authoredChannelId against the $declaredChannelId schema",
    ({ declaredChannelId, authoredChannelId }) => {
      const manifestRegistry: PluginManifestRegistry = {
        diagnostics: [],
        plugins: [
          createPluginManifestRecord({
            id: `alias-${declaredChannelId}`,
            origin: "global",
            channels: [declaredChannelId],
            channelConfigs: {
              [declaredChannelId]: {
                schema: {
                  type: "object",
                  properties: { endpoint: { type: "string" } },
                  required: ["endpoint"],
                  additionalProperties: false,
                },
              },
            },
          }),
        ],
      };

      const result = validateConfigObjectRawWithPlugins(
        { channels: { [authoredChannelId]: { endpoint: 42 } } },
        { pluginMetadataSnapshot: { manifestRegistry } },
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues).toContainEqual(
          expect.objectContaining({ path: `channels.${authoredChannelId}.endpoint` }),
        );
      }
    },
  );

  it("uses the metadata ownership key for every generated and runtime catalog spelling", () => {
    const entries = [
      ...GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA.map((entry) => ({
        id: entry.channelId,
        aliases: entry.aliases ?? [],
      })),
      ...listBundledChannelCatalogEntries(),
    ];
    const spellings = new Set<string>();
    for (const entry of entries) {
      expect(normalizeChannelMetadataKey(entry.id)).toBe(entry.id);
      for (const spelling of [entry.id, ...entry.aliases]) {
        expect(normalizeChannelMetadataKey(spelling)).toBe(entry.id);
        spellings.add(spelling);
        spellings.add(spelling.toUpperCase());
      }
    }
    const channelSchema = {
      schema: {
        type: "object",
        properties: { endpoint: { type: "string" } },
        required: ["endpoint"],
        additionalProperties: false,
      },
    };
    const manifestRegistry: PluginManifestRegistry = {
      diagnostics: [],
      plugins: [
        createPluginManifestRecord({
          id: "catalog-normalization-contract",
          origin: "global",
          channels: [...spellings],
          channelConfigs: Object.fromEntries(
            [...spellings].map((spelling) => [spelling, channelSchema]),
          ),
        }),
      ],
    };
    const result = validateConfigObjectRawWithPlugins(
      {
        channels: Object.fromEntries(
          [...spellings].map((spelling) => [spelling, { endpoint: 42 }]),
        ),
      },
      { pluginMetadataSnapshot: { manifestRegistry } },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const issuePaths = new Set(result.issues.map((issue) => issue.path));
      expect(
        [...spellings].filter((spelling) => !issuePaths.has(`channels.${spelling}.endpoint`)),
      ).toEqual([]);
    }
  });

  it.each(["TELEGRAM", "Telegram", "lark"])(
    "rejects %s, which canonicalises onto a real channel but is read by nothing at runtime",
    (authored) => {
      const result = validateConfigObjectRawWithPlugins(
        { channels: { [authored]: { enabled: true } } },
        { pluginMetadataSnapshot: { manifestRegistry: { diagnostics: [], plugins: [] } } },
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues).toContainEqual({
          path: `channels.${authored}`,
          message: `unknown channel id: ${authored}`,
        });
      }
    },
  );

  it("rejects an authored spelling that differs from the one the plugin declares", () => {
    // The plugin declares `qywx`; runtime reads `channels.qywx`. An authored `channels.QYWX`
    // canonicalises onto the same channel but is never read, so schema-validating it would
    // report a block that does nothing as healthy.
    const manifestRegistry: PluginManifestRegistry = {
      diagnostics: [],
      plugins: [
        createPluginManifestRecord({
          id: "alias-qywx",
          origin: "global",
          channels: ["qywx"],
          channelConfigs: {
            qywx: {
              schema: {
                type: "object",
                properties: { endpoint: { type: "string" } },
                required: ["endpoint"],
                additionalProperties: false,
              },
            },
          },
        }),
      ],
    };

    const result = validateConfigObjectRawWithPlugins(
      { channels: { QYWX: { endpoint: 42 } } },
      { pluginMetadataSnapshot: { manifestRegistry } },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual({
        path: "channels.QYWX",
        message: "unknown channel id: QYWX",
      });
      expect(result.issues.map((issue) => issue.path)).not.toContain("channels.QYWX.endpoint");
    }
  });

  it("keeps reserved channel container keys case-sensitive", () => {
    const result = validateConfigObjectRawWithPlugins(
      { channels: { Defaults: {} } },
      { pluginMetadataSnapshot: { manifestRegistry: { diagnostics: [], plugins: [] } } },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual({
        path: "channels.Defaults",
        message: "unknown channel id: Defaults",
      });
    }
  });

  // ClawSweeper P1 (dotted channel ids bypass sensitive-field redaction): redaction derives a
  // channel's metadata key by cutting at the first dot after `channels.`, so for an id that itself
  // contains a dot only the leading segment is canonicalised -- `channels.Acme.Chat.x` normalises
  // to `channels.acme.Chat.x`. Two spellings of one dotted id therefore produce two different
  // metadata keys, and a hint authored under one would miss config authored under the other.
  //
  // Reaching that needs a config authored in a spelling the manifest does not declare, and this is
  // the gate that makes it unauthorable: membership is tested against the declared spelling, so
  // every variant below is rejected outright and its fields are never schema-validated. Dotted ids
  // are covered by the same rule as `QYWX` above; pinned separately because the redaction cut makes
  // dotted ids the case where the two spellings would actually diverge.
  it.each(["Acme.Chat", "ACME.CHAT", "acme.Chat"])(
    "rejects %s, a dotted-channel spelling the plugin does not declare",
    (authored) => {
      const manifestRegistry: PluginManifestRegistry = {
        diagnostics: [],
        plugins: [
          createPluginManifestRecord({
            id: "acme-plugin",
            origin: "global",
            channels: ["acme.chat"],
            channelConfigs: {
              "acme.chat": {
                schema: {
                  type: "object",
                  additionalProperties: false,
                  properties: { opaqueCredential: { type: "string" } },
                },
              },
            },
          }),
        ],
      };

      const result = validateConfigObjectRawWithPlugins(
        { channels: { [authored]: { opaqueCredential: "secret" } } },
        { pluginMetadataSnapshot: { manifestRegistry } },
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues).toContainEqual({
          path: `channels.${authored}`,
          message: `unknown channel id: ${authored}`,
        });
        expect(result.issues.map((issue) => issue.path)).not.toContain(
          `channels.${authored}.opaqueCredential`,
        );
      }
    },
  );

  it("accepts a dotted channel id authored exactly as the plugin declares it", () => {
    const manifestRegistry: PluginManifestRegistry = {
      diagnostics: [],
      plugins: [
        createPluginManifestRecord({
          id: "acme-plugin",
          origin: "global",
          channels: ["acme.chat"],
          channelConfigs: {
            "acme.chat": {
              schema: {
                type: "object",
                additionalProperties: false,
                properties: { opaqueCredential: { type: "string" } },
              },
            },
          },
        }),
      ],
    };

    const result = validateConfigObjectRawWithPlugins(
      { channels: { "acme.chat": { opaqueCredential: "secret" } } },
      { pluginMetadataSnapshot: { manifestRegistry } },
    );

    expect(
      result.ok ? [] : result.issues.filter((issue) => issue.path.startsWith("channels.")),
    ).toEqual([]);
  });

  // The same gate in the other direction: the leak needs the hint and the config to disagree, and
  // the hint carries whatever spelling the manifest declares. A manifest declaring the capitalised
  // dotted id makes the lowercase config the unauthorable half, so neither ordering reaches
  // redaction with two spellings in play.
  it("rejects a lowercase dotted spelling when the plugin declares the capitalised one", () => {
    const manifestRegistry: PluginManifestRegistry = {
      diagnostics: [],
      plugins: [
        createPluginManifestRecord({
          id: "acme-plugin",
          origin: "global",
          channels: ["Acme.Chat"],
          channelConfigs: {
            "Acme.Chat": {
              schema: {
                type: "object",
                additionalProperties: false,
                properties: { opaqueCredential: { type: "string" } },
              },
            },
          },
        }),
      ],
    };

    const result = validateConfigObjectRawWithPlugins(
      { channels: { "acme.chat": { opaqueCredential: "secret" } } },
      { pluginMetadataSnapshot: { manifestRegistry } },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual({
        path: "channels.acme.chat",
        message: "unknown channel id: acme.chat",
      });
    }
  });
});
