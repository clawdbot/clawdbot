import { beforeAll, describe, expect, it } from "vitest";
import { migrateLegacyConfig } from "./legacy-config-migrate.js";

describe("legacy config migrate validation", () => {
  let groupChatRoutingResult: ReturnType<typeof migrateLegacyConfig>;
  let partialValidationResult: ReturnType<typeof migrateLegacyConfig>;
  let agentModelTimeoutResult: ReturnType<typeof migrateLegacyConfig>;
  let modelThinkingFormatResult: ReturnType<typeof migrateLegacyConfig>;

  beforeAll(() => {
    groupChatRoutingResult = migrateLegacyConfig({
      routing: {
        allowFrom: ["+15550001111"],
        groupChat: {
          requireMention: false,
          historyLimit: 8,
          mentionPatterns: ["@openclaw"],
        },
      },
      channels: {
        whatsapp: {},
        telegram: {},
      },
    });
    partialValidationResult = migrateLegacyConfig({
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.5" },
          llm: { idleTimeoutSeconds: 120 },
        },
      },
      plugins: {
        entries: {
          brave: {
            enabled: true,
            config: { webSearch: { mode: "definitely-invalid" } },
          },
        },
      },
      tools: { web: { search: { provider: "brave" } } },
    });
    agentModelTimeoutResult = migrateLegacyConfig({
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.5", timeoutMs: 30_000 },
          subagents: {
            model: { primary: "openai/gpt-5.4", timeoutMs: 10_000 },
          },
          imageGenerationModel: {
            primary: "openrouter/openai/gpt-5.4-image-2",
            timeoutMs: 180_000,
          },
        },
        list: [
          {
            id: "worker",
            model: { primary: "openai/gpt-5.4", timeoutMs: 20_000 },
            subagents: {
              model: { primary: "openai/gpt-5.4-mini", timeoutMs: 5_000 },
            },
          },
        ],
      },
    });
    modelThinkingFormatResult = migrateLegacyConfig({
      models: {
        providers: {
          bailian: {
            baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
            api: "openai-completions",
            models: [
              {
                id: "qwen-legacy",
                name: "Qwen Legacy",
                compat: {
                  thinkingFormat: "bailian-legacy",
                  supportsTools: true,
                },
              },
              {
                id: "qwen-valid",
                name: "Qwen Valid",
                compat: {
                  thinkingFormat: "qwen",
                },
              },
            ],
          },
        },
      },
    });
  });

  it("returns valid migrated config for legacy group chat routing drift", () => {
    const res = groupChatRoutingResult;
    expect(res.partiallyValid).toBeUndefined();
    const migratedConfig = res.config as Record<string, unknown> | null;
    expect(migratedConfig?.routing).toBeUndefined();
    expect(res.config?.channels?.whatsapp?.allowFrom).toEqual(["+15550001111"]);
    expect(res.config?.channels?.whatsapp?.groups).toEqual({
      "*": { requireMention: false },
    });
    expect(res.config?.channels?.telegram?.groups).toEqual({
      "*": { requireMention: false },
    });
    expect(res.config?.messages?.groupChat).toEqual({
      historyLimit: 8,
      mentionPatterns: ["@openclaw"],
    });
    expect(res.changes).toStrictEqual([
      "Moved routing.allowFrom → channels.whatsapp.allowFrom.",
      'Moved routing.groupChat.requireMention → channels.whatsapp.groups."*".requireMention.',
      'Moved routing.groupChat.requireMention → channels.telegram.groups."*".requireMention.',
      "Moved routing.groupChat.historyLimit → messages.groupChat.historyLimit.",
      "Moved routing.groupChat.mentionPatterns → messages.groupChat.mentionPatterns.",
    ]);
  });

  it("returns migrated config when unrelated plugin validation issues remain (#76798)", () => {
    const res = partialValidationResult;

    expect(res.partiallyValid).toBe(true);
    expect(res.changes).toStrictEqual([
      "Removed agents.defaults.llm; model idle timeout now follows models.providers.<id>.timeoutSeconds within the agent/run timeout ceiling.",
      "Migration applied; other validation issues remain — run doctor to review.",
    ]);
    expect(res.config?.agents?.defaults).toEqual({
      model: { primary: "openai/gpt-5.5" },
    });
    expect(res.config?.tools?.web?.search?.provider).toBe("brave");
  });

  it("returns valid config after removing ignored agent model timeouts", () => {
    const res = agentModelTimeoutResult;

    expect(res.partiallyValid).toBeUndefined();
    expect(res.changes).toStrictEqual([
      "Removed agents.defaults.model.timeoutMs; agent model config only selects models.",
      "Removed agents.defaults.subagents.model.timeoutMs; agent model config only selects models.",
      "Removed agents.list.0.model.timeoutMs; agent model config only selects models.",
      "Removed agents.list.0.subagents.model.timeoutMs; agent model config only selects models.",
    ]);
    expect(res.config?.agents?.defaults?.model).toEqual({ primary: "openai/gpt-5.5" });
    expect(res.config?.agents?.defaults?.subagents?.model).toEqual({
      primary: "openai/gpt-5.4",
    });
    expect(res.config?.agents?.defaults?.imageGenerationModel).toEqual({
      primary: "openrouter/openai/gpt-5.4-image-2",
      timeoutMs: 180_000,
    });
    expect(res.config?.agents?.list?.[0]?.model).toEqual({ primary: "openai/gpt-5.4" });
    expect(res.config?.agents?.list?.[0]?.subagents?.model).toEqual({
      primary: "openai/gpt-5.4-mini",
    });
  });

  it("returns valid config after removing invalid model compat thinkingFormat", () => {
    const res = modelThinkingFormatResult;

    expect(res.partiallyValid).toBeUndefined();
    expect(res.changes).toStrictEqual([
      'Removed models.providers.bailian.models.0.compat.thinkingFormat (unrecognized value "bailian-legacy"; runtime default applies).',
    ]);
    expect(res.config?.models?.providers?.bailian?.models?.[0]?.compat).toEqual({
      supportsTools: true,
    });
    expect(res.config?.models?.providers?.bailian?.models?.[1]?.compat).toEqual({
      thinkingFormat: "qwen",
    });
  });
});
