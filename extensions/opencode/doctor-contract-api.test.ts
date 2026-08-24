import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { normalizeCompatibilityConfig } from "./doctor-contract-api.js";

const RETIRED = "opencode/hy3-free";
const REPLACEMENT = "opencode/laguna-s-2.1-free";

describe("OpenCode doctor compatibility normalization", () => {
  it("repairs every canonical model surface and removes retired catalog rows", () => {
    const input = {
      unrelated: { preserved: true, apiKey: "must-not-appear" },
      agents: {
        defaults: {
          model: {
            primary: "OpenCode/HY3-FREE",
            fallbacks: [`${RETIRED}@secret-profile`, "other/model", 42],
          },
          utilityModel: RETIRED,
          imageModel: { primary: RETIRED },
          voiceModel: RETIRED,
          pdfModel: RETIRED,
          mediaModels: {
            image: RETIRED,
            video: { primary: RETIRED, fallbacks: [RETIRED] },
            music: RETIRED,
          },
          heartbeat: { model: RETIRED },
          subagents: { model: { primary: RETIRED, fallbacks: [RETIRED] } },
          compaction: { model: RETIRED, memoryFlush: { model: RETIRED } },
          models: {
            [RETIRED]: { alias: "retired" },
            [REPLACEMENT]: { alias: "canonical" },
            "other/model": { alias: "other" },
          },
          modelPolicy: { allow: [RETIRED, "opencode/*", "alias"] },
        },
        entries: {
          worker: {
            model: RETIRED,
            models: { [`${RETIRED}@work`]: { alias: "profiled" } },
            modelPolicy: { allow: [`${RETIRED}@work`] },
            tools: { exec: { reviewer: { model: RETIRED } } },
            tts: { summaryModel: RETIRED },
          },
        },
        list: [
          {
            id: "shadow",
            model: RETIRED,
            modelPolicy: { allow: [RETIRED] },
            tools: { exec: { reviewer: { model: RETIRED } } },
            tts: { summaryModel: RETIRED },
          },
        ],
      },
      tools: { exec: { reviewer: { model: RETIRED } } },
      hooks: {
        mappings: [{ model: RETIRED }],
        gmail: { model: RETIRED },
      },
      tts: { summaryModel: RETIRED },
      channels: {
        modelByChannel: { discord: { guild: RETIRED } },
        discord: {
          voice: { model: RETIRED, tts: { summaryModel: RETIRED } },
          accounts: {
            work: { voice: { model: RETIRED, tts: { summaryModel: RETIRED } } },
          },
        },
      },
      models: {
        providers: {
          opencode: {
            models: [
              { id: "HY3-FREE", name: "retired" },
              { id: "laguna-s-2.1-free", name: "canonical" },
              { id: "custom", name: "custom" },
              "malformed",
            ],
          },
        },
      },
    };
    const original = structuredClone(input);

    const first = normalizeCompatibilityConfig({
      cfg: input as unknown as OpenClawConfig,
    });
    const migrated = first.config as unknown as typeof input;

    expect(input).toEqual(original);
    expect(migrated.unrelated).toEqual(input.unrelated);
    expect(migrated.agents.defaults.model).toEqual({
      primary: REPLACEMENT,
      fallbacks: [`${REPLACEMENT}@secret-profile`, "other/model", 42],
    });
    expect([
      migrated.agents.defaults.utilityModel,
      migrated.agents.defaults.imageModel.primary,
      migrated.agents.defaults.voiceModel,
      migrated.agents.defaults.pdfModel,
      migrated.agents.defaults.mediaModels.image,
      migrated.agents.defaults.mediaModels.video.primary,
      migrated.agents.defaults.mediaModels.video.fallbacks[0],
      migrated.agents.defaults.mediaModels.music,
      migrated.agents.defaults.heartbeat.model,
      migrated.agents.defaults.subagents.model.primary,
      migrated.agents.defaults.subagents.model.fallbacks[0],
      migrated.agents.defaults.compaction.model,
      migrated.agents.defaults.compaction.memoryFlush.model,
      migrated.agents.entries.worker.model,
      migrated.hooks.mappings[0]?.model,
      migrated.hooks.gmail.model,
      migrated.tts.summaryModel,
      migrated.channels.modelByChannel.discord.guild,
      migrated.channels.discord.voice.model,
      migrated.channels.discord.voice.tts.summaryModel,
      migrated.channels.discord.accounts.work.voice.model,
      migrated.channels.discord.accounts.work.voice.tts.summaryModel,
      migrated.tools.exec.reviewer.model,
      migrated.agents.entries.worker.tools.exec.reviewer.model,
      migrated.agents.entries.worker.tts.summaryModel,
    ]).toEqual(Array.from({ length: 25 }, () => REPLACEMENT));
    expect(migrated.agents.defaults.models).toEqual({
      [REPLACEMENT]: { alias: "canonical" },
      "other/model": { alias: "other" },
    });
    expect(migrated.agents.defaults.modelPolicy.allow).toEqual([
      REPLACEMENT,
      "opencode/*",
      "alias",
    ]);
    expect(migrated.agents.entries.worker.models).toEqual({
      [`${REPLACEMENT}@work`]: { alias: "profiled" },
    });
    expect(migrated.agents.entries.worker.modelPolicy.allow).toEqual([`${REPLACEMENT}@work`]);
    expect(migrated.agents.list).toEqual(input.agents.list);
    expect(migrated.models.providers.opencode.models).toEqual([
      { id: "laguna-s-2.1-free", name: "canonical" },
      { id: "custom", name: "custom" },
      "malformed",
    ]);
    expect(first.changes).toEqual(
      expect.arrayContaining([
        expect.stringContaining("agents.defaults.model.primary"),
        expect.stringContaining("agents.defaults.modelPolicy.allow.0"),
        expect.stringContaining("agents.entries.worker.models"),
        expect.stringContaining("channels.discord.voice.model"),
        expect.stringContaining("models.providers.opencode.models"),
      ]),
    );
    expect(first.changes.join("\n")).not.toContain("secret-profile");
    expect(first.changes.join("\n")).not.toContain("must-not-appear");

    const second = normalizeCompatibilityConfig({ cfg: first.config });
    expect(second).toEqual({ config: first.config, changes: [] });
    expect(second.config).toBe(first.config);
  });

  it("uses the legacy list only when keyed entries are absent", () => {
    const legacy = {
      agents: {
        list: [
          {
            id: "legacy",
            model: RETIRED,
            modelPolicy: { allow: [RETIRED] },
            tools: { exec: { reviewer: { model: RETIRED } } },
            tts: { summaryModel: RETIRED },
          },
        ],
      },
    };

    const result = normalizeCompatibilityConfig({
      cfg: legacy as unknown as OpenClawConfig,
    }).config as unknown as typeof legacy;

    expect(result.agents.list[0]).toEqual({
      id: "legacy",
      model: REPLACEMENT,
      modelPolicy: { allow: [REPLACEMENT] },
      tools: { exec: { reviewer: { model: REPLACEMENT } } },
      tts: { summaryModel: REPLACEMENT },
    });
    expect(legacy.agents.list[0]?.model).toBe(RETIRED);
  });

  it("never rewrites a shadow list when entries exists", () => {
    const input = {
      agents: {
        entries: {},
        list: [{ id: "shadow", model: RETIRED, modelPolicy: { allow: [RETIRED] } }],
      },
    };

    const result = normalizeCompatibilityConfig({
      cfg: input as unknown as OpenClawConfig,
    });

    expect(result).toEqual({ config: input, changes: [] });
    expect(result.config).toBe(input);
  });

  it("never rewrites a shadow list when entries is null", () => {
    const input = {
      agents: {
        entries: null,
        list: [
          {
            id: "shadow",
            model: RETIRED,
            tools: { exec: { reviewer: { model: RETIRED } } },
            tts: { summaryModel: RETIRED },
          },
        ],
      },
    };

    expect(normalizeCompatibilityConfig({ cfg: input as unknown as OpenClawConfig })).toEqual({
      config: input,
      changes: [],
    });
  });

  it("repairs only structured OpenCode provider media entries", () => {
    const input = {
      tools: {
        media: {
          image: { preferredModel: "opencode/hy3-free" },
          audio: { preferredModel: "hy3-free" },
          video: { preferredModel: "OPENCODE/HY3-FREE@work" },
          models: [
            {
              provider: " OpenCode ",
              model: " HY3-FREE ",
              profile: "work",
              capabilities: ["image"],
            },
            { type: "cli", provider: "opencode", model: "hy3-free", command: "opencode" },
            { provider: "opencode", model: "hy3-free", command: "opencode" },
            { provider: "other", model: "hy3-free" },
            { provider: "opencode", model: "opencode/hy3-free" },
            { provider: "opencode", model: "hy3-free@work" },
            "malformed",
          ],
        },
      },
    };
    const original = structuredClone(input);

    const result = normalizeCompatibilityConfig({
      cfg: input as unknown as OpenClawConfig,
    });
    const migrated = result.config as unknown as typeof input;

    expect(input).toEqual(original);
    expect(migrated.tools.media.models[0]).toEqual({
      provider: "opencode",
      model: "laguna-s-2.1-free",
      profile: "work",
      capabilities: ["image"],
    });
    expect(migrated.tools.media.models.slice(1)).toEqual(input.tools.media.models.slice(1));
    expect(migrated.tools.media.image.preferredModel).toBe(REPLACEMENT);
    expect(migrated.tools.media.audio.preferredModel).toBe("hy3-free");
    expect(migrated.tools.media.video.preferredModel).toBe(`${REPLACEMENT}@work`);
    expect(result.changes).toEqual([
      "Updated tools.media.models.0 to the current OpenCode Zen model.",
      `Updated tools.media.image.preferredModel from the retired OpenCode Zen model to ${REPLACEMENT}.`,
      `Updated tools.media.video.preferredModel from the retired OpenCode Zen model to ${REPLACEMENT}.`,
    ]);
  });

  it.each([
    "hy3-free",
    "opencode-go/hy3",
    "opencode/*",
    "prefix opencode/hy3-free suffix",
    "opencode/hy3-free@",
    "opencode/hy3-free@profile/with/slash",
  ])("does not rewrite non-exact ref %s", (model) => {
    const input = { agents: { defaults: { model } } };
    const result = normalizeCompatibilityConfig({ cfg: input as OpenClawConfig });

    expect(result).toEqual({ config: input, changes: [] });
    expect(result.config).toBe(input);
  });

  it("ignores non-string and malformed selector values", () => {
    const input = {
      agents: {
        defaults: {
          model: { primary: 42, fallbacks: [null, { model: RETIRED }] },
          modelPolicy: { allow: [42, null] },
          models: [RETIRED],
        },
      },
    };
    const result = normalizeCompatibilityConfig({
      cfg: input as unknown as OpenClawConfig,
    });

    expect(result).toEqual({ config: input, changes: [] });
  });
});
