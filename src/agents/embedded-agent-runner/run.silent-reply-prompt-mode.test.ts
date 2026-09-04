import { beforeAll, describe, expect, it } from "vitest";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedRunEmbeddedAttempt,
  createOverflowRunParams,
  type TestRunEmbeddedAgent,
  useOpenAIPlatformAuthFixture,
} from "./run.overflow-compaction.harness.js";
import { buildAttemptSystemPrompt } from "./run/attempt-system-prompt.js";
import type { EmbeddedRunAttemptParams } from "./run/types.js";

let runEmbeddedAgent: TestRunEmbeddedAgent;

type AttemptParams = Pick<EmbeddedRunAttemptParams, "silentReplyPromptMode">;

function buildPrompt(silentReplyPromptMode: AttemptParams["silentReplyPromptMode"]): string {
  return buildAttemptSystemPrompt({
    isRawModelRun: false,
    transformProviderSystemPrompt: ({ context }) => context.systemPrompt,
    embeddedSystemPrompt: {
      workspaceDir: "/tmp/test-workspace",
      reasoningTagHint: false,
      silentReplyPromptMode,
      runtimeInfo: {
        host: "test-host",
        os: "Linux",
        arch: "x64",
        node: "v22.0.0",
        model: "test-provider/test-model",
      },
      tools: [],
      modelAliasLines: [],
      userTimezone: "UTC",
      bootstrapMode: "full",
      contextFiles: [],
    },
    providerTransform: {
      provider: "test-provider",
      workspaceDir: "/tmp/test-workspace",
      context: {
        provider: "test-provider",
        modelId: "test-model",
        promptMode: "full",
      },
    },
  }).systemPrompt;
}

describe("embedded runner silent reply prompt mode", () => {
  beforeAll(async () => {
    ({ runEmbeddedAgent } = await loadRunOverflowCompactionHarness());
  });

  it("preserves none across the attempt boundary and omits generic silent-reply guidance", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult());
    useOpenAIPlatformAuthFixture();

    await runEmbeddedAgent({
      ...createOverflowRunParams({ workspaceDir: "/tmp/test-workspace" }),
      provider: "openai",
      model: "gpt-5.6-luna",
      silentReplyPromptMode: "none",
    });

    const attemptParams = mockedRunEmbeddedAttempt.mock.calls[0]?.[0] as
      | AttemptParams
      | undefined;
    expect(attemptParams?.silentReplyPromptMode).toBe("none");
    expect(buildPrompt(attemptParams?.silentReplyPromptMode)).not.toContain("## Silent Replies");
    expect(buildPrompt("generic")).toContain("## Silent Replies");
  });
});
