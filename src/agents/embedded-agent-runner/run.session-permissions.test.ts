import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedRunEmbeddedAttempt,
  createOverflowRunParams,
  resetSharedRunIntegrationHarnessMocks,
  type TestRunEmbeddedAgent,
  useOpenAIPlatformAuthFixture,
  warmRunOverflowCompactionHarness,
} from "./run.overflow-compaction.harness.js";

// The mocked harness only supports the OpenAI route, so these params keep the
// plugin harness selected. Falling back to the built-in host harness would drag
// the whole OpenClaw tool graph into this shard and prove the wrong owner.
function createPluginHarnessRunParams(state: OpenClawTestState) {
  return {
    ...createOverflowRunParams(state),
    provider: "openai",
    model: "gpt-5.6-luna",
    sessionRoot: state.sessionsDir(),
  } as const;
}

let state: OpenClawTestState;

describe("embedded run session permissions", () => {
  let runEmbeddedAgent: TestRunEmbeddedAgent;

  beforeAll(async () => {
    ({ runEmbeddedAgent } = await loadRunOverflowCompactionHarness());
    const { withOpenClawTestState } = await import("../../test-utils/openclaw-test-state.js");
    await withOpenClawTestState({ label: "session-permissions-warmup" }, async (warmupState) => {
      await warmRunOverflowCompactionHarness(runEmbeddedAgent, warmupState);
    });
  });

  beforeEach(async () => {
    resetSharedRunIntegrationHarnessMocks();
    const { createOpenClawTestState } = await import("../../test-utils/openclaw-test-state.js");
    state = await createOpenClawTestState({ label: "run.session-permissions" });
    useOpenAIPlatformAuthFixture();
  });

  afterEach(async () => {
    await state?.cleanup();
  });

  it("prepares the exec mode with plugin-owned permission facts", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ assistantTexts: ["OK"] }));

    await runEmbeddedAgent({
      ...createPluginHarnessRunParams(state),
      permissionMode: "workspace",
      runId: "run-plugin-session-permissions",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        agentHarnessId: "codex",
        execOverrides: expect.objectContaining({ mode: "auto" }),
        permissionMode: "workspace",
        sessionRoot: state.sessionsDir(),
      }),
    );
  });

  it("shares the final plugin-clamped exec mode with the outer run", async () => {
    const execOverrides = {};
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (attempt) => {
      expect(attempt.execOverrides).toBe(execOverrides);
      expect(attempt.execOverrides?.mode).toBe("full");
      attempt.permissionMode = "workspace";
      attempt.execOverrides!.mode = "auto";
      return makeAttemptResult({ assistantTexts: ["OK"] });
    });

    await runEmbeddedAgent({
      ...createPluginHarnessRunParams(state),
      permissionMode: "full",
      execOverrides,
      runId: "run-plugin-clamped-session-permissions",
    });

    expect(execOverrides).toEqual({ mode: "auto" });
  });
});
