// Verifies validation reads channel schema ownership from the authored sourceConfig.

import { describe, expect, it } from "vitest";
import type { PluginManifestRecord, PluginManifestRegistry } from "../plugins/manifest-registry.js";
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
});
