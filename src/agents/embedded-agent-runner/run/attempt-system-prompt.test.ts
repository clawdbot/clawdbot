// Coverage for assembling provider-transformed embedded attempt system prompts.
import { beforeAll, describe, expect, it } from "vitest";

let buildAttemptSystemPrompt: typeof import("./attempt-system-prompt.js").buildAttemptSystemPrompt;

beforeAll(async () => {
  ({ buildAttemptSystemPrompt } = await import("./attempt-system-prompt.js"));
});

const baseProviderTransform = {
  provider: "openai",
  workspaceDir: "/tmp/openclaw",
  context: {
    provider: "openai",
    modelId: "gpt-5.5",
    promptMode: "full" as const,
  },
};

const transformProviderSystemPrompt: Parameters<
  typeof buildAttemptSystemPrompt
>[0]["transformProviderSystemPrompt"] = ({ context }) => context.systemPrompt;

describe("buildAttemptSystemPrompt", () => {
  it("injects workspace identity context", () => {
    // Workspace identity files are part of the base system prompt and must
    // survive provider transformation.
    const result = buildAttemptSystemPrompt({
      isRawModelRun: false,
      transformProviderSystemPrompt,
      embeddedSystemPrompt: {
        workspaceDir: "/tmp/openclaw",
        reasoningTagHint: false,
        runtimeInfo: {
          host: "test-host",
          os: "Darwin",
          arch: "arm64",
          node: "v22.0.0",
          model: "openai/gpt-5.5",
        },
        tools: [],
        modelAliasLines: [],
        userTimezone: "UTC",
        contextFiles: [
          { path: "/tmp/openclaw/SOUL.md", content: "SOUL_CONTEXT_MARKER" },
          { path: "/tmp/openclaw/IDENTITY.md", content: "IDENTITY_CONTEXT_MARKER" },
          { path: "/tmp/openclaw/USER.md", content: "USER_CONTEXT_MARKER" },
        ],
      },
      providerTransform: baseProviderTransform,
    });

    expect(result.systemPrompt).toContain("# Project Context");
    expect(result.systemPrompt).toContain("## /tmp/openclaw/SOUL.md");
    expect(result.systemPrompt).toContain("SOUL_CONTEXT_MARKER");
    expect(result.systemPrompt).toContain("## /tmp/openclaw/IDENTITY.md");
    expect(result.systemPrompt).toContain("IDENTITY_CONTEXT_MARKER");
    expect(result.systemPrompt).toContain("## /tmp/openclaw/USER.md");
    expect(result.systemPrompt).toContain("USER_CONTEXT_MARKER");
  });

  it("preserves bootstrap Project Context", () => {
    const result = buildAttemptSystemPrompt({
      isRawModelRun: false,
      transformProviderSystemPrompt,
      embeddedSystemPrompt: {
        workspaceDir: "/tmp/openclaw",
        reasoningTagHint: false,
        runtimeInfo: {
          host: "test-host",
          os: "Darwin",
          arch: "arm64",
          node: "v22.0.0",
          model: "openai/gpt-5.5",
        },
        tools: [],
        modelAliasLines: [],
        userTimezone: "UTC",
        bootstrapMode: "full",
        bootstrapTruncationNotice: "Bootstrap context was truncated.",
        contextFiles: [
          {
            path: "/tmp/openclaw/BOOTSTRAP.md",
            content: "Reply with BOOTSTRAP_OK.",
          },
          {
            path: "/tmp/openclaw/SOUL.md",
            content: "SOUL_CONTEXT_MARKER",
          },
          {
            path: "/tmp/openclaw/IDENTITY.md",
            content: "IDENTITY_CONTEXT_MARKER",
          },
          {
            path: "/tmp/openclaw/USER.md",
            content: "USER_CONTEXT_MARKER",
          },
        ],
      },
      providerTransform: baseProviderTransform,
    });

    expect(result.systemPrompt).toContain("Current model identity: openai/gpt-5.5.");
    expect(result.systemPrompt).toContain("## Bootstrap Pending");
    expect(result.systemPrompt).toContain("BOOTSTRAP.md below; follow before normal reply.");
    expect(result.systemPrompt).toContain("## Bootstrap Context Notice");
    expect(result.systemPrompt).toContain("Bootstrap context was truncated.");
    expect(result.systemPrompt).toContain("# Project Context");
    expect(result.systemPrompt).toContain("## /tmp/openclaw/SOUL.md");
    expect(result.systemPrompt).toContain("SOUL_CONTEXT_MARKER");
    expect(result.systemPrompt).toContain("## /tmp/openclaw/IDENTITY.md");
    expect(result.systemPrompt).toContain("IDENTITY_CONTEXT_MARKER");
    expect(result.systemPrompt).toContain("## /tmp/openclaw/USER.md");
    expect(result.systemPrompt).toContain("USER_CONTEXT_MARKER");
    expect(result.systemPrompt).toContain("## /tmp/openclaw/BOOTSTRAP.md");
    expect(result.systemPrompt).toContain("Reply with BOOTSTRAP_OK.");
  });

  it("preserves runtime extra system prompt context", () => {
    const result = buildAttemptSystemPrompt({
      isRawModelRun: false,
      transformProviderSystemPrompt,
      embeddedSystemPrompt: {
        workspaceDir: "/tmp/openclaw",
        reasoningTagHint: false,
        runtimeInfo: {
          host: "test-host",
          os: "Darwin",
          arch: "arm64",
          node: "v22.0.0",
          model: "openai/gpt-5.5",
        },
        tools: [],
        modelAliasLines: [],
        userTimezone: "UTC",
        promptMode: "minimal",
        extraSystemPrompt:
          "# Subagent Context\n\n## Your Role\n- You were created to handle: RUN_MODE_TASK_77950",
        bootstrapMode: "full",
        contextFiles: [],
      },
      providerTransform: baseProviderTransform,
    });

    expect(result.systemPrompt).toContain("Current model identity: openai/gpt-5.5.");
    expect(result.systemPrompt).toContain("## Subagent Context");
    expect(result.systemPrompt).toContain("RUN_MODE_TASK_77950");
  });

  it("omits system prompts for raw model probes", () => {
    // Raw model probes still build a base prompt for diagnostics, but the final
    // provider prompt must be empty.
    const result = buildAttemptSystemPrompt({
      isRawModelRun: true,
      transformProviderSystemPrompt,
      embeddedSystemPrompt: {
        workspaceDir: "/tmp/openclaw",
        reasoningTagHint: false,
        runtimeInfo: {
          host: "test-host",
          os: "Darwin",
          arch: "arm64",
          node: "v22.0.0",
          model: "openai/gpt-5.5",
        },
        tools: [],
        modelAliasLines: [],
        userTimezone: "UTC",
        bootstrapMode: "full",
        contextFiles: [
          {
            path: "/tmp/openclaw/BOOTSTRAP.md",
            content: "Reply with BOOTSTRAP_OK.",
          },
        ],
      },
      providerTransform: baseProviderTransform,
    });

    expect(result.baseSystemPrompt).toContain("BOOTSTRAP.md below; follow before normal reply.");
    expect(result.systemPrompt).toBe("");
  });
});
