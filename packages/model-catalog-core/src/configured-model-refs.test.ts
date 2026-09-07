// Model Catalog Core tests cover configured model refs behavior.
import { describe, expect, it } from "vitest";
import {
  collectConfiguredModelRefs,
  collectConfiguredModelRefValues,
  listModelRefsFromConfigValue,
} from "./configured-model-refs.js";

describe("configured model refs", () => {
  it("lists raw refs from one model selector without normalizing them", () => {
    expect(listModelRefsFromConfigValue("  openai/gpt-5.5  ")).toEqual(["  openai/gpt-5.5  "]);
    const selector = Object.freeze({
      primary: " primary/model ",
      fallbacks: Object.freeze(["", "fallback/model", 42, "fallback/model"]),
    });
    expect(listModelRefsFromConfigValue(selector)).toEqual([
      " primary/model ",
      "",
      "fallback/model",
      "fallback/model",
    ]);
    expect(collectConfiguredModelRefs({ agents: { defaults: { model: selector } } })).toEqual([
      { path: "agents.defaults.model.primary", value: "primary/model" },
      { path: "agents.defaults.model.fallbacks.1", value: "fallback/model" },
      { path: "agents.defaults.model.fallbacks.3", value: "fallback/model" },
    ]);
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
          channels: {
            modelByChannel: { discord: { guild: "anthropic/claude-sonnet-4-6" } },
            discord: { voice: { tts: { summaryModel: "discord-tts/model" } } },
          },
        },
        { includeChannelModelOverrides: false },
      ),
    ).toEqual(["openai/gpt-5.5", "discord-tts/model"]);
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

  it.each([
    {
      name: "global exec reviewer string",
      config: { tools: { exec: { reviewer: { model: "global-review/model" } } } },
      expected: [{ path: "tools.exec.reviewer.model", value: "global-review/model" }],
    },
    {
      name: "global exec reviewer selector",
      config: {
        tools: {
          exec: {
            reviewer: {
              model: { primary: "global-primary/model", fallbacks: ["global-fallback/model"] },
            },
          },
        },
      },
      expected: [
        { path: "tools.exec.reviewer.model.primary", value: "global-primary/model" },
        { path: "tools.exec.reviewer.model.fallbacks.0", value: "global-fallback/model" },
      ],
    },
    {
      name: "media preferences",
      config: {
        tools: {
          media: {
            image: { preferredModel: "image-provider/model" },
            audio: { preferredModel: "audio-provider/model" },
            video: { preferredModel: "video-provider/model" },
          },
        },
      },
      expected: [
        {
          path: "tools.media.image.preferredModel",
          value: "image-provider/model",
        },
        {
          path: "tools.media.audio.preferredModel",
          value: "audio-provider/model",
        },
        {
          path: "tools.media.video.preferredModel",
          value: "video-provider/model",
        },
      ],
    },
    {
      name: "keyed agent exec reviewer",
      config: {
        agents: {
          entries: {
            worker: {
              tools: {
                exec: {
                  reviewer: {
                    model: {
                      primary: "entry-review-primary/model",
                      fallbacks: ["entry-review-fallback/model"],
                    },
                  },
                },
              },
            },
          },
        },
      },
      expected: [
        {
          path: "agents.entries.worker.tools.exec.reviewer.model.primary",
          value: "entry-review-primary/model",
        },
        {
          path: "agents.entries.worker.tools.exec.reviewer.model.fallbacks.0",
          value: "entry-review-fallback/model",
        },
      ],
    },
    {
      name: "legacy agent exec reviewer",
      config: {
        agents: {
          list: [{ id: "worker", tools: { exec: { reviewer: { model: "list-review/model" } } } }],
        },
      },
      expected: [{ path: "agents.list.0.tools.exec.reviewer.model", value: "list-review/model" }],
    },
    {
      name: "keyed agent TTS summary",
      config: { agents: { entries: { worker: { tts: { summaryModel: "entry-tts/model" } } } } },
      expected: [{ path: "agents.entries.worker.tts.summaryModel", value: "entry-tts/model" }],
    },
    {
      name: "legacy agent TTS summary",
      config: { agents: { list: [{ id: "worker", tts: { summaryModel: "list-tts/model" } }] } },
      expected: [{ path: "agents.list.0.tts.summaryModel", value: "list-tts/model" }],
    },
    {
      name: "Discord root voice model",
      config: { channels: { discord: { voice: { model: "discord-voice/model" } } } },
      expected: [{ path: "channels.discord.voice.model", value: "discord-voice/model" }],
    },
    {
      name: "Discord root voice TTS summary",
      config: { channels: { discord: { voice: { tts: { summaryModel: "discord-tts/model" } } } } },
      expected: [{ path: "channels.discord.voice.tts.summaryModel", value: "discord-tts/model" }],
    },
    {
      name: "Discord account voice model",
      config: {
        channels: { discord: { accounts: { work: { voice: { model: "account-voice/model" } } } } },
      },
      expected: [
        { path: "channels.discord.accounts.work.voice.model", value: "account-voice/model" },
      ],
    },
    {
      name: "Discord account voice TTS summary",
      config: {
        channels: {
          discord: {
            accounts: { work: { voice: { tts: { summaryModel: "account-tts/model" } } } },
          },
        },
      },
      expected: [
        {
          path: "channels.discord.accounts.work.voice.tts.summaryModel",
          value: "account-tts/model",
        },
      ],
    },
  ])("collects $name", ({ config, expected }) => {
    expect(collectConfiguredModelRefs(config)).toEqual(expected);
  });

  it.each([{}, null])("does not inspect a shadow list when entries is %j", (entries) => {
    expect(
      collectConfiguredModelRefs({
        agents: {
          entries,
          list: [{ id: "shadow", tools: { exec: { reviewer: { model: "shadow/model" } } } }],
        },
      }),
    ).toEqual([]);
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
