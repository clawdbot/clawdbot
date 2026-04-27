import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./validation.js";
import { AgentDefaultsSchema } from "./zod-schema.agent-defaults.js";
import { AgentEntrySchema } from "./zod-schema.agent-runtime.js";

describe("agent defaults schema", () => {
  it("accepts subagent archiveAfterMinutes=0 to disable archiving", () => {
    expect(() =>
      AgentDefaultsSchema.parse({
        subagents: {
          archiveAfterMinutes: 0,
        },
      }),
    ).not.toThrow();
  });

  it("accepts videoGenerationModel", () => {
    expect(() =>
      AgentDefaultsSchema.parse({
        videoGenerationModel: {
          primary: "qwen/wan2.6-t2v",
          fallbacks: ["minimax/video-01"],
        },
      }),
    ).not.toThrow();
  });

  it("accepts imageGenerationModel timeoutMs", () => {
    const defaults = AgentDefaultsSchema.parse({
      imageGenerationModel: {
        primary: "openrouter/openai/gpt-5.4-image-2",
        timeoutMs: 180_000,
      },
    })!;

    expect(defaults.imageGenerationModel).toEqual({
      primary: "openrouter/openai/gpt-5.4-image-2",
      timeoutMs: 180_000,
    });
    expect(() =>
      AgentDefaultsSchema.parse({
        imageGenerationModel: {
          primary: "openrouter/openai/gpt-5.4-image-2",
          timeoutMs: 0,
        },
      }),
    ).toThrow();
  });

  it("accepts mediaGenerationAutoProviderFallback", () => {
    expect(() =>
      AgentDefaultsSchema.parse({
        mediaGenerationAutoProviderFallback: false,
      }),
    ).not.toThrow();
  });

  it("accepts experimental.localModelLean", () => {
    const result = AgentDefaultsSchema.parse({
      experimental: {
        localModelLean: true,
      },
    })!;
    expect(result.experimental?.localModelLean).toBe(true);
  });

  it("accepts contextInjection: always", () => {
    const result = AgentDefaultsSchema.parse({ contextInjection: "always" })!;
    expect(result.contextInjection).toBe("always");
  });

  it("accepts contextInjection: continuation-skip", () => {
    const result = AgentDefaultsSchema.parse({ contextInjection: "continuation-skip" })!;
    expect(result.contextInjection).toBe("continuation-skip");
  });

  it("accepts contextInjection: never", () => {
    const result = AgentDefaultsSchema.parse({ contextInjection: "never" })!;
    expect(result.contextInjection).toBe("never");
  });

  it("rejects invalid contextInjection values", () => {
    expect(() => AgentDefaultsSchema.parse({ contextInjection: "unknown" })).toThrow();
  });

  it("accepts embeddedPi.executionContract", () => {
    const result = AgentDefaultsSchema.parse({
      embeddedPi: {
        executionContract: "strict-agentic",
      },
    })!;
    expect(result.embeddedPi?.executionContract).toBe("strict-agentic");
  });

  it("accepts compaction.truncateAfterCompaction", () => {
    const result = AgentDefaultsSchema.parse({
      compaction: {
        truncateAfterCompaction: true,
        maxActiveTranscriptBytes: "20mb",
      },
    })!;
    expect(result.compaction?.truncateAfterCompaction).toBe(true);
    expect(result.compaction?.maxActiveTranscriptBytes).toBe("20mb");
  });

  it("accepts focused contextLimits on defaults and agent entries", () => {
    const defaults = AgentDefaultsSchema.parse({
      contextLimits: {
        memoryGetMaxChars: 20_000,
        memoryGetDefaultLines: 200,
        toolResultMaxChars: 24_000,
        postCompactionMaxChars: 4_000,
      },
    })!;
    const agent = AgentEntrySchema.parse({
      id: "ops",
      skillsLimits: {
        maxSkillsPromptChars: 30_000,
      },
      contextLimits: {
        memoryGetMaxChars: 18_000,
      },
    });

    expect(defaults.contextLimits?.memoryGetMaxChars).toBe(20_000);
    expect(defaults.contextLimits?.memoryGetDefaultLines).toBe(200);
    expect(defaults.contextLimits?.toolResultMaxChars).toBe(24_000);
    expect(agent.skillsLimits?.maxSkillsPromptChars).toBe(30_000);
    expect(agent.contextLimits?.memoryGetMaxChars).toBe(18_000);
  });

  it("accepts positive heartbeat timeoutSeconds on defaults and agent entries", () => {
    const defaults = AgentDefaultsSchema.parse({
      heartbeat: { timeoutSeconds: 45 },
    })!;
    const agent = AgentEntrySchema.parse({
      id: "ops",
      heartbeat: { timeoutSeconds: 45 },
    });

    expect(defaults.heartbeat?.timeoutSeconds).toBe(45);
    expect(agent.heartbeat?.timeoutSeconds).toBe(45);
  });

  it("accepts per-agent TTS overrides", () => {
    const agent = AgentEntrySchema.parse({
      id: "reader",
      tts: {
        provider: "openai",
        auto: "always",
        providers: {
          openai: {
            voice: "nova",
            apiKey: "${OPENAI_API_KEY}",
          },
        },
      },
    });

    expect(agent.tts?.provider).toBe("openai");
    expect(agent.tts?.providers?.openai?.voice).toBe("nova");
  });

  it("rejects zero heartbeat timeoutSeconds", () => {
    expect(() => AgentDefaultsSchema.parse({ heartbeat: { timeoutSeconds: 0 } })).toThrow();
    expect(() => AgentEntrySchema.parse({ id: "ops", heartbeat: { timeoutSeconds: 0 } })).toThrow();
  });

  it("preserves per-agent contextTokens through config validation", () => {
    const result = validateConfigObject({
      agents: {
        list: [
          {
            id: "ops",
            contextTokens: 1_048_576,
          },
        ],
      },
    });

    expect(result).toMatchObject({
      ok: true,
      config: {
        agents: {
          list: [{ contextTokens: 1_048_576 }],
        },
      },
    });
  });

  it("rejects non-positive contextTokens on agent entries and defaults", () => {
    expect(() => AgentEntrySchema.parse({ id: "ops", contextTokens: 0 })).toThrow();
    expect(() => AgentEntrySchema.parse({ id: "ops", contextTokens: -1 })).toThrow();
    expect(() => AgentEntrySchema.parse({ id: "ops", contextTokens: 1.5 })).toThrow();
    expect(() => AgentDefaultsSchema.parse({ contextTokens: 0 })).toThrow();
  });
});
