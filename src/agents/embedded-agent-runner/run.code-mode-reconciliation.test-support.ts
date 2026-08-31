import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { buildEmbeddedRunnerAssistant } from "../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  mockedClassifyFailoverReason,
  mockedRunEmbeddedAttempt,
  createOverflowRunParams,
  resetSharedRunIntegrationHarnessMocks,
  useOpenAIPlatformAuthFixture,
} from "./run.overflow-compaction.harness.js";
import { loadSharedRunIntegrationHarness } from "./run.shared-integration-harness.test-support.js";

let state: OpenClawTestState;
let runEmbeddedAgent: Awaited<ReturnType<typeof loadSharedRunIntegrationHarness>>;

describe("runEmbeddedAgent Code Mode reconciliation", () => {
  beforeAll(async () => {
    runEmbeddedAgent = await loadSharedRunIntegrationHarness();
  });

  beforeEach(async () => {
    resetSharedRunIntegrationHarnessMocks();
    const { createOpenClawTestState } = await import("../../test-utils/openclaw-test-state.js");
    state = await createOpenClawTestState({ label: "run.code-mode-reconciliation" });
    mockedClassifyFailoverReason.mockReturnValue(null);
    useOpenAIPlatformAuthFixture();
  });

  afterEach(async () => {
    await state?.cleanup();
  });

  it("continues a settled partial mutation through inspection and bounded recovery", async () => {
    const mutationAssistant = buildEmbeddedRunnerAssistant({
      stopReason: "toolUse",
      content: [
        {
          type: "toolCall",
          id: "code-mode-mutation",
          name: "code_mode",
          arguments: { action: "exec" },
        },
      ],
    });
    const retryAssistant = buildEmbeddedRunnerAssistant({
      stopReason: "error",
      content: [],
    });
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          assistantTexts: [],
          lastAssistant: mutationAssistant,
          currentAttemptAssistant: mutationAssistant,
          currentAttemptCompletedAssistant: mutationAssistant,
          codeModeRecoveryCandidate: { blockedActionKeys: ["apply_patch:prior"] },
          itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
        }),
      )
      .mockResolvedValueOnce(
        makeAttemptResult({
          assistantTexts: [],
          itemLifecycle: { startedCount: 2, completedCount: 2, activeCount: 0 },
          toolMetas: [
            { toolName: "read", isError: false },
            { toolName: "recovery_resume", isError: false, terminate: true },
          ],
        }),
      )
      .mockResolvedValueOnce(
        makeAttemptResult({
          assistantTexts: [],
          lastAssistant: retryAssistant,
          currentAttemptAssistant: retryAssistant,
          currentAttemptCompletedAssistant: retryAssistant,
        }),
      )
      .mockResolvedValueOnce(makeAttemptResult({ assistantTexts: ["Recovery completed."] }));

    await runEmbeddedAgent({
      ...createOverflowRunParams(state),
      config: {
        agents: {
          defaults: {
            models: { "openai/gpt-5.5": { agentRuntime: { id: "openclaw" } } },
          },
        },
      },
      provider: "openai",
      model: "gpt-5.5",
      runId: "run-code-mode-reconciliation",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(4);
    expect(mockedRunEmbeddedAttempt.mock.calls[1]?.[0]).toMatchObject({
      codeModeRecovery: { kind: "inspect" },
      prompt: expect.stringContaining("may have partially applied"),
    });
    expect(mockedRunEmbeddedAttempt.mock.calls[2]?.[0]).toMatchObject({
      codeModeOverride: false,
      codeModeRecovery: { kind: "resume" },
    });
    expect(mockedRunEmbeddedAttempt.mock.calls[3]?.[0]).toMatchObject({
      codeModeOverride: false,
      codeModeRecovery: { kind: "resume" },
      prompt: expect.stringContaining("at most one mutation attempt"),
    });
  });

  it("ends after inspection when no recovery is requested", async () => {
    const mutationAssistant = buildEmbeddedRunnerAssistant({
      stopReason: "toolUse",
      content: [
        {
          type: "toolCall",
          id: "code-mode-mutation",
          name: "code_mode",
          arguments: { action: "exec" },
        },
      ],
    });
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          assistantTexts: [],
          lastAssistant: mutationAssistant,
          currentAttemptAssistant: mutationAssistant,
          currentAttemptCompletedAssistant: mutationAssistant,
          codeModeRecoveryCandidate: { blockedActionKeys: ["apply_patch:prior"] },
          itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
        }),
      )
      .mockResolvedValueOnce(
        makeAttemptResult({
          assistantTexts: ["The requested change already applied."],
          itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
          toolMetas: [{ toolName: "read", isError: false }],
        }),
      );

    await runEmbeddedAgent({
      ...createOverflowRunParams(state),
      config: {
        agents: {
          defaults: {
            models: { "openai/gpt-5.5": { agentRuntime: { id: "openclaw" } } },
          },
        },
      },
      provider: "openai",
      model: "gpt-5.5",
      runId: "run-code-mode-reconciliation-complete",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(mockedRunEmbeddedAttempt.mock.calls[1]?.[0]).toMatchObject({
      codeModeRecovery: { kind: "inspect" },
    });
  });
});
