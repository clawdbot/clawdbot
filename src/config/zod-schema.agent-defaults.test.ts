import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./validation.js";
import { AgentDefaultsSchema } from "./zod-schema.agent-defaults.js";
import { AgentEntrySchema } from "./zod-schema.agent-runtime.js";

type SchemaParseResult = {
  success: boolean;
  error?: { issues: Array<{ path: Array<string | number | symbol> }> };
};

function expectSchemaSuccess(result: SchemaParseResult): void {
  expect(result.success).toBe(true);
}

function expectSchemaFailurePath(result: SchemaParseResult, expectedPathPrefix: string): void {
  expect(result.success).toBe(false);
  if (result.success || !result.error) {
    throw new Error(`Expected schema validation to fail at ${expectedPathPrefix}.`);
  }
  const issuePaths = result.error.issues.map((issue) => issue.path.join("."));
  expect(
    issuePaths.some(
      (path) => path === expectedPathPrefix || path.startsWith(`${expectedPathPrefix}.`),
    ),
  ).toBe(true);
}

describe("agent defaults schema", () => {
  it("accepts subagent archiveAfterMinutes=0 to disable archiving", () => {
    expectSchemaSuccess(
      AgentDefaultsSchema.safeParse({
        subagents: {
          archiveAfterMinutes: 0,
        },
      }),
    );
  });

  it("accepts subagent delegation mode on defaults and agent entries", () => {
    expectSchemaSuccess(
      AgentDefaultsSchema.safeParse({
        subagents: {
          delegationMode: "prefer",
        },
      }),
    );
    expectSchemaSuccess(
      AgentEntrySchema.safeParse({
        id: "coordinator",
        subagents: {
          delegationMode: "suggest",
        },
      }),
    );
    expectSchemaFailurePath(
      AgentDefaultsSchema.safeParse({
        subagents: {
          delegationMode: "required",
        },
      }),
      "subagents.delegationMode",
    );
  });

  it("accepts videoGenerationModel", () => {
    expectSchemaSuccess(
      AgentDefaultsSchema.safeParse({
        videoGenerationModel: {
          primary: "qwen/wan2.6-t2v",
          fallbacks: ["minimax/video-01"],
        },
      }),
    );
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
    expectSchemaFailurePath(
      AgentDefaultsSchema.safeParse({
        imageGenerationModel: {
          primary: "openrouter/openai/gpt-5.4-image-2",
          timeoutMs: 0,
        },
      }),
      "imageGenerationModel.timeoutMs",
    );
  });

  it("accepts mediaGenerationAutoProviderFallback", () => {
    expectSchemaSuccess(
      AgentDefaultsSchema.safeParse({
        mediaGenerationAutoProviderFallback: false,
      }),
    );
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
    expectSchemaFailurePath(
      AgentDefaultsSchema.safeParse({ contextInjection: "unknown" }),
      "contextInjection",
    );
  });

  it("accepts supported optional bootstrap filenames", () => {
    const result = AgentDefaultsSchema.parse({
      skipOptionalBootstrapFiles: ["SOUL.md", "USER.md", "HEARTBEAT.md", "IDENTITY.md"],
    })!;
    expect(result.skipOptionalBootstrapFiles).toEqual([
      "SOUL.md",
      "USER.md",
      "HEARTBEAT.md",
      "IDENTITY.md",
    ]);
  });

  it("rejects unsupported optional bootstrap filenames", () => {
    expectSchemaFailurePath(
      AgentDefaultsSchema.safeParse({ skipOptionalBootstrapFiles: ["AGENTS.md"] }),
      "skipOptionalBootstrapFiles",
    );
    expectSchemaFailurePath(
      AgentDefaultsSchema.safeParse({ skipOptionalBootstrapFiles: ["SOUL.MD"] }),
      "skipOptionalBootstrapFiles",
    );
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

  it("accepts compaction.midTurnPrecheck.enabled", () => {
    const result = AgentDefaultsSchema.parse({
      compaction: {
        mode: "safeguard",
        midTurnPrecheck: {
          enabled: true,
        },
      },
    })!;

    expect(result.compaction?.midTurnPrecheck?.enabled).toBe(true);
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
      heartbeat: { timeoutSeconds: 45, skipWhenBusy: true },
    })!;
    const agent = AgentEntrySchema.parse({
      id: "ops",
      heartbeat: { timeoutSeconds: 45, skipWhenBusy: true },
    });

    expect(defaults.heartbeat?.timeoutSeconds).toBe(45);
    expect(defaults.heartbeat?.skipWhenBusy).toBe(true);
    expect(agent.heartbeat?.timeoutSeconds).toBe(45);
    expect(agent.heartbeat?.skipWhenBusy).toBe(true);
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
    expectSchemaFailurePath(
      AgentDefaultsSchema.safeParse({ heartbeat: { timeoutSeconds: 0 } }),
      "heartbeat.timeoutSeconds",
    );
    expectSchemaFailurePath(
      AgentEntrySchema.safeParse({ id: "ops", heartbeat: { timeoutSeconds: 0 } }),
      "heartbeat.timeoutSeconds",
    );
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

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected config validation to succeed");
    }
    const config = result.config as { agents?: { list?: Array<{ contextTokens?: number }> } };
    expect(config.agents?.list?.[0]?.contextTokens).toBe(1_048_576);
  });

  it("rejects non-positive contextTokens on agent entries and defaults", () => {
    expectSchemaFailurePath(
      AgentEntrySchema.safeParse({ id: "ops", contextTokens: 0 }),
      "contextTokens",
    );
    expectSchemaFailurePath(
      AgentEntrySchema.safeParse({ id: "ops", contextTokens: -1 }),
      "contextTokens",
    );
    expectSchemaFailurePath(
      AgentEntrySchema.safeParse({ id: "ops", contextTokens: 1.5 }),
      "contextTokens",
    );
    expectSchemaFailurePath(AgentDefaultsSchema.safeParse({ contextTokens: 0 }), "contextTokens");
  });
});
