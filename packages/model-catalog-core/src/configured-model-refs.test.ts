// Model Catalog Core tests cover configured model refs behavior.
import { describe, expect, it } from "vitest";
import {
  collectConfiguredModelRefs,
  collectConfiguredModelRefValues,
  listModelRefsFromConfigValue,
  extractProviderFromModelRef,
  pruneOrphanModelRefs,
} from "./configured-model-refs.js";

describe("configured model refs", () => {
  it("lists raw refs from one model selector without normalizing them", () => {
    expect(listModelRefsFromConfigValue("  openai/gpt-5.5  ")).toEqual(["  openai/gpt-5.5  "]);
    expect(
      listModelRefsFromConfigValue({
        primary: " primary/model ",
        fallbacks: ["", "fallback/model", 42, "fallback/model"],
      }),
    ).toEqual([" primary/model ", "", "fallback/model", "fallback/model"]);
    expect(listModelRefsFromConfigValue(["openai/gpt-5.5"])).toEqual([]);
    expect(listModelRefsFromConfigValue({ primary: 42, fallbacks: "openai/gpt-5.5" })).toEqual([]);
  });

  it("collects agent, hook, message, and channel model refs with config paths", () => {
    expect(
      collectConfiguredModelRefs({
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.5", fallbacks: ["anthropic/claude-sonnet-4-6"] },
            utilityModel: "google/gemini-3.1-flash-lite-preview",
            mediaModels: { image: "openai/gpt-image-2" },
            compaction: { memoryFlush: { model: "openai/gpt-5.5-mini" } },
          },
          entries: {
            custom: {
              model: "xai/grok-4-fast",
              utilityModel: "openai/gpt-5.5-nano",
            },
          },
        },
        hooks: {
          mappings: [{ model: "openai/gpt-5.5-nano" }],
        },
        tts: { summaryModel: "openai/gpt-5.5-mini" },
        channels: {
          modelByChannel: {
            discord: {
              guild: "anthropic/claude-opus-4-8",
            },
          },
        },
      }),
    ).toEqual([
      { path: "agents.defaults.model.primary", value: "openai/gpt-5.5" },
      { path: "agents.defaults.model.fallbacks.0", value: "anthropic/claude-sonnet-4-6" },
      {
        path: "agents.defaults.utilityModel",
        value: "google/gemini-3.1-flash-lite-preview",
      },
      { path: "agents.defaults.mediaModels.image", value: "openai/gpt-image-2" },
      { path: "agents.defaults.compaction.memoryFlush.model", value: "openai/gpt-5.5-mini" },
      { path: "agents.entries.custom.model", value: "xai/grok-4-fast" },
      { path: "agents.entries.custom.utilityModel", value: "openai/gpt-5.5-nano" },
      { path: "channels.modelByChannel.discord.guild", value: "anthropic/claude-opus-4-8" },
      { path: "hooks.mappings.0.model", value: "openai/gpt-5.5-nano" },
      { path: "tts.summaryModel", value: "openai/gpt-5.5-mini" },
    ]);
  });

  it("can exclude channel model overrides from configured refs", () => {
    expect(
      collectConfiguredModelRefValues(
        {
          agents: { defaults: { model: "openai/gpt-5.5" } },
          channels: { modelByChannel: { discord: { guild: "anthropic/claude-sonnet-4-6" } } },
        },
        { includeChannelModelOverrides: false },
      ),
    ).toEqual(["openai/gpt-5.5"]);
  });

  it("preserves legacy list indices when collecting agent model refs", () => {
    expect(
      collectConfiguredModelRefs({
        agents: {
          list: [
            { id: "10", model: "openai/gpt-5.6" },
            { id: "2", utilityModel: "anthropic/claude-sonnet-4-6" },
          ],
        },
      }),
    ).toEqual([
      { path: "agents.list.0.model", value: "openai/gpt-5.6" },
      { path: "agents.list.1.utilityModel", value: "anthropic/claude-sonnet-4-6" },
    ]);
  });

  it("ignores a shadowed legacy list when keyed entries are authoritative", () => {
    expect(
      collectConfiguredModelRefs({
        agents: {
          entries: { ops: { model: "openai/gpt-5.6" } },
          list: [{ id: "stale", model: "anthropic/claude-opus-4-8" }],
        },
      }),
    ).toEqual([{ path: "agents.entries.ops.model", value: "openai/gpt-5.6" }]);
  });

  it("ignores array-shaped malformed records", () => {
    expect(
      collectConfiguredModelRefs({
        agents: {
          defaults: {
            models: ["openai/gpt-5.5"],
          },
        },
      }),
    ).toEqual([]);
  });
});

describe("pruneOrphanModelRefs", () => {
  const catalogOptions = (modelRefs: readonly string[], fallbackModelRef?: string) => {
    const knownProviderIds = new Set<string>();
    for (const modelRef of modelRefs) {
      const provider = extractProviderFromModelRef(modelRef);
      if (provider) {
        knownProviderIds.add(provider);
      }
    }
    return {
      knownProviderIds,
      knownModelRefs: new Set(modelRefs),
      ...(fallbackModelRef ? { fallbackModelRef } : {}),
    };
  };

  it("removes allowlist map entries for missing providers", () => {
    const result = pruneOrphanModelRefs(
      {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.5": {},
              "ghostprovider/model-a": { alias: "ghost-a" },
              "anthropic/claude-sonnet-4-6": {},
            },
          },
        },
      },
      catalogOptions(["openai/gpt-5.5", "anthropic/claude-sonnet-4-6"]),
    );
    expect(result.config).toEqual({
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.5": {},
            "anthropic/claude-sonnet-4-6": {},
          },
        },
      },
    });
    expect(result.pruned).toEqual([
      {
        path: "agents.defaults.models.ghostprovider/model-a",
        value: "ghostprovider/model-a",
        reason: "missing-provider",
      },
    ]);
  });

  it("removes fallback array entries for missing providers", () => {
    const result = pruneOrphanModelRefs(
      {
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-5.5",
              fallbacks: ["anthropic/claude-sonnet-4-6", "ghostprovider/foo", "openai/gpt-5.4"],
            },
          },
        },
      },
      catalogOptions(["openai/gpt-5.5", "openai/gpt-5.4", "anthropic/claude-sonnet-4-6"]),
    );
    expect(result.config).toEqual({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.5",
            fallbacks: ["anthropic/claude-sonnet-4-6", "openai/gpt-5.4"],
          },
        },
      },
    });
    expect(result.pruned).toEqual([
      {
        path: "agents.defaults.model.fallbacks.1",
        value: "ghostprovider/foo",
        reason: "missing-provider",
      },
    ]);
  });

  it("rewrites primary refs using agents.defaults.model.primary as fallback", () => {
    const result = pruneOrphanModelRefs(
      {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.5" },
          },
          list: [{ id: "agent-a", model: { primary: "ghostprovider/model-x" } }],
        },
      },
      catalogOptions(["openai/gpt-5.5"]),
    );
    expect(result.config).toEqual({
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.5" },
        },
        list: [{ id: "agent-a", model: { primary: "openai/gpt-5.5" } }],
      },
    });
    expect(result.pruned).toEqual([
      {
        path: "agents.list.0.model.primary",
        value: "ghostprovider/model-x",
        reason: "missing-provider",
        replacement: "openai/gpt-5.5",
      },
    ]);
  });

  it("rewrites primary refs to a concrete configured fallback when defaults.model.primary is also orphan", () => {
    const result = pruneOrphanModelRefs(
      {
        agents: {
          defaults: {
            model: { primary: "ghostprovider/model-y" },
          },
          list: [{ id: "agent-a", model: { primary: "ghostprovider/model-x" } }],
        },
      },
      catalogOptions(
        ["openai/gpt-5.5", "anthropic/claude-sonnet-4-6"],
        "anthropic/claude-sonnet-4-6",
      ),
    );
    expect(result.config).toEqual({
      agents: {
        defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } },
        list: [{ id: "agent-a", model: { primary: "anthropic/claude-sonnet-4-6" } }],
      },
    });
    expect(result.pruned).toEqual([
      {
        path: "agents.defaults.model.primary",
        value: "ghostprovider/model-y",
        reason: "missing-provider",
        replacement: "anthropic/claude-sonnet-4-6",
      },
      {
        path: "agents.list.0.model.primary",
        value: "ghostprovider/model-x",
        reason: "missing-provider",
        replacement: "anthropic/claude-sonnet-4-6",
      },
    ]);
  });

  it("deletes stale scalar refs instead of inventing provider/default fallbacks", () => {
    const result = pruneOrphanModelRefs(
      {
        agents: {
          defaults: {
            model: { primary: "ghostprovider/model-y" },
          },
          list: [{ id: "agent-a", model: "ghostprovider/model-x" }],
        },
      },
      catalogOptions(["openai/gpt-5.5", "anthropic/claude-sonnet-4-6"]),
    );
    expect(result.config).toEqual({
      agents: {
        defaults: {
          model: {},
        },
        list: [{ id: "agent-a" }],
      },
    });
    expect(result.pruned).toEqual([
      {
        path: "agents.defaults.model.primary",
        value: "ghostprovider/model-y",
        reason: "missing-provider",
      },
      {
        path: "agents.list.0.model",
        value: "ghostprovider/model-x",
        reason: "missing-provider",
      },
    ]);
  });

  it("prunes from agents.list entries", () => {
    const result = pruneOrphanModelRefs(
      {
        agents: {
          defaults: {
            model: "openai/gpt-5.5",
          },
          list: [
            { id: "agent-a", model: { fallbacks: ["ghostprovider/a", "openai/gpt-5.5"] } },
            { id: "agent-b", models: { "ghostprovider/b": {}, "openai/gpt-5.5": {} } },
          ],
        },
      },
      catalogOptions(["openai/gpt-5.5"]),
    );
    expect(result.config).toEqual({
      agents: {
        defaults: {
          model: "openai/gpt-5.5",
        },
        list: [
          { id: "agent-a", model: { fallbacks: ["openai/gpt-5.5"] } },
          { id: "agent-b", models: { "openai/gpt-5.5": {} } },
        ],
      },
    });
    expect(result.pruned).toHaveLength(2);
  });

  it("ignores refs without provider prefix", () => {
    const result = pruneOrphanModelRefs(
      {
        agents: {
          defaults: {
            model: "gpt-5.5",
            models: { "gpt-5.5": {} },
          },
        },
      },
      catalogOptions(["openai/gpt-5.5"]),
    );
    expect(result.config).toEqual({
      agents: {
        defaults: {
          model: "gpt-5.5",
          models: { "gpt-5.5": {} },
        },
      },
    });
    expect(result.pruned).toEqual([]);
  });

  it("preserves models when provider exists", () => {
    const result = pruneOrphanModelRefs(
      {
        agents: {
          defaults: {
            models: { "openai/gpt-5.5": {}, "anthropic/claude-sonnet-4-6": {} },
          },
        },
      },
      catalogOptions(["openai/gpt-5.5", "anthropic/claude-sonnet-4-6"]),
    );
    expect(result.config).toEqual({
      agents: {
        defaults: {
          models: { "openai/gpt-5.5": {}, "anthropic/claude-sonnet-4-6": {} },
        },
      },
    });
    expect(result.pruned).toEqual([]);
  });

  it("removes allowlist map entries for provider refs missing from the runtime catalog", () => {
    const result = pruneOrphanModelRefs(
      {
        agents: {
          defaults: {
            models: { "openai/gpt-5.5": {}, "openai/retired-model": {} },
          },
        },
      },
      catalogOptions(["openai/gpt-5.5"]),
    );
    expect(result.config).toEqual({
      agents: {
        defaults: {
          models: { "openai/gpt-5.5": {} },
        },
      },
    });
    expect(result.pruned).toEqual([
      {
        path: "agents.defaults.models.openai/retired-model",
        value: "openai/retired-model",
        reason: "missing-model",
      },
    ]);
  });

  it("preserves provider wildcard allowlist entries for known runtime catalog providers", () => {
    const result = pruneOrphanModelRefs(
      {
        agents: {
          defaults: {
            models: { "openai/*": {}, "ghostprovider/*": {} },
          },
        },
      },
      catalogOptions(["openai/gpt-5.5"]),
    );
    expect(result.config).toEqual({
      agents: {
        defaults: {
          models: { "openai/*": {} },
        },
      },
    });
    expect(result.pruned).toEqual([
      {
        path: "agents.defaults.models.ghostprovider/*",
        value: "ghostprovider/*",
        reason: "missing-provider",
      },
    ]);
  });

  it("handles compaction.model and subagents.model rewriting", () => {
    const result = pruneOrphanModelRefs(
      {
        agents: {
          defaults: {
            model: "openai/gpt-5.5",
            compaction: { model: "ghostprovider/a", memoryFlush: { model: "ghostprovider/b" } },
            subagents: { model: { primary: "ghostprovider/c", fallbacks: ["ghostprovider/d"] } },
          },
        },
      },
      catalogOptions(["openai/gpt-5.5"]),
    );
    expect(result.config).toEqual({
      agents: {
        defaults: {
          model: "openai/gpt-5.5",
          compaction: {
            model: "openai/gpt-5.5",
            memoryFlush: { model: "openai/gpt-5.5" },
          },
          subagents: { model: { primary: "openai/gpt-5.5", fallbacks: [] } },
        },
      },
    });
    expect(result.pruned).toEqual([
      {
        path: "agents.defaults.subagents.model.primary",
        value: "ghostprovider/c",
        reason: "missing-provider",
        replacement: "openai/gpt-5.5",
      },
      {
        path: "agents.defaults.subagents.model.fallbacks.0",
        value: "ghostprovider/d",
        reason: "missing-provider",
      },
      {
        path: "agents.defaults.compaction.model",
        value: "ghostprovider/a",
        reason: "missing-provider",
        replacement: "openai/gpt-5.5",
      },
      {
        path: "agents.defaults.compaction.memoryFlush.model",
        value: "ghostprovider/b",
        reason: "missing-provider",
        replacement: "openai/gpt-5.5",
      },
    ]);
  });

  it("prunes keyed agent entries and media model selectors", () => {
    const result = pruneOrphanModelRefs(
      {
        agents: {
          defaults: { model: "openai/gpt-5.5" },
          entries: {
            ops: {
              utilityModel: "ghostprovider/utility",
              mediaModels: {
                image: "ghostprovider/image",
                video: {
                  primary: "openai/gpt-5.5",
                  fallbacks: ["ghostprovider/video"],
                },
              },
            },
          },
          list: [{ id: "shadowed", model: "ghostprovider/legacy" }],
        },
      },
      catalogOptions(["openai/gpt-5.5"]),
    );
    expect(result.config).toEqual({
      agents: {
        defaults: { model: "openai/gpt-5.5" },
        entries: {
          ops: {
            utilityModel: "openai/gpt-5.5",
            mediaModels: {
              image: "openai/gpt-5.5",
              video: { primary: "openai/gpt-5.5", fallbacks: [] },
            },
          },
        },
        list: [{ id: "shadowed", model: "ghostprovider/legacy" }],
      },
    });
    expect(result.pruned.map((ref) => ref.path)).toEqual([
      "agents.entries.ops.utilityModel",
      "agents.entries.ops.mediaModels.image",
      "agents.entries.ops.mediaModels.video.fallbacks.0",
    ]);
  });

  it("prunes hooks.mappings and hooks.gmail model refs", () => {
    const result = pruneOrphanModelRefs(
      {
        agents: { defaults: { model: "openai/gpt-5.5" } },
        hooks: {
          mappings: [{ model: "ghostprovider/hook-a" }],
          gmail: { model: "ghostprovider/hook-b" },
        },
      },
      catalogOptions(["openai/gpt-5.5"]),
    );
    expect(result.config).toEqual({
      agents: { defaults: { model: "openai/gpt-5.5" } },
      hooks: {
        mappings: [{ model: "openai/gpt-5.5" }],
        gmail: { model: "openai/gpt-5.5" },
      },
    });
    expect(result.pruned.every((p) => p.replacement === "openai/gpt-5.5")).toBe(true);
  });

  it("prunes tts.summaryModel", () => {
    const result = pruneOrphanModelRefs(
      {
        agents: { defaults: { model: "anthropic/claude-sonnet-4-6" } },
        tts: { summaryModel: "ghostprovider/tts-model" },
      },
      catalogOptions(["anthropic/claude-sonnet-4-6"]),
    );
    expect(result.config).toEqual({
      agents: { defaults: { model: "anthropic/claude-sonnet-4-6" } },
      tts: { summaryModel: "anthropic/claude-sonnet-4-6" },
    });
    expect(result.pruned).toEqual([
      {
        path: "tts.summaryModel",
        value: "ghostprovider/tts-model",
        reason: "missing-provider",
        replacement: "anthropic/claude-sonnet-4-6",
      },
    ]);
  });

  it("prunes channels.modelByChannel and channels.discord.voice.model", () => {
    const result = pruneOrphanModelRefs(
      {
        agents: { defaults: { model: "openai/gpt-5.5" } },
        channels: {
          modelByChannel: {
            discord: { guild: "ghostprovider/discord-a" },
            telegram: { chat: "openai/gpt-5.4" },
          },
          discord: { voice: { model: "ghostprovider/voice-model" } },
        },
      },
      catalogOptions(["openai/gpt-5.5", "openai/gpt-5.4"]),
    );
    expect(result.config).toEqual({
      agents: { defaults: { model: "openai/gpt-5.5" } },
      channels: {
        modelByChannel: {
          discord: { guild: "openai/gpt-5.5" },
          telegram: { chat: "openai/gpt-5.4" },
        },
        discord: { voice: { model: "openai/gpt-5.5" } },
      },
    });
    expect(result.pruned).toHaveLength(2);
  });
});
