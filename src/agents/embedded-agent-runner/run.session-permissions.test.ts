import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
  useOpenAIPlatformAuthFixture,
  warmRunOverflowCompactionHarness,
} from "./run.overflow-compaction.harness.js";

const { runEmbeddedAgent } = await loadRunOverflowCompactionHarness();

// The mocked harness only supports the OpenAI route, so these params keep the
// plugin harness selected. Falling back to the built-in host harness would drag
// the whole OpenClaw tool graph into this shard and prove the wrong owner.
const pluginHarnessRunParams = {
  ...overflowBaseRunParams,
  provider: "openai",
  model: "gpt-5.6-luna",
  sessionRoot: "/tmp/openclaw-plugin-session-root",
} as const;

describe("embedded run session permissions", () => {
  beforeAll(async () => {
    await warmRunOverflowCompactionHarness(runEmbeddedAgent);
  });

  beforeEach(() => {
    mockedRunEmbeddedAttempt.mockReset();
    useOpenAIPlatformAuthFixture();
  });

  it("prepares the exec mode with plugin-owned permission facts", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ assistantTexts: ["OK"] }));

    await runEmbeddedAgent({
      ...pluginHarnessRunParams,
      permissionMode: "workspace",
      runId: "run-plugin-session-permissions",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        agentHarnessId: "codex",
        execOverrides: expect.objectContaining({ mode: "auto" }),
        permissionMode: "workspace",
        sessionRoot: "/tmp/openclaw-plugin-session-root",
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
      ...pluginHarnessRunParams,
      permissionMode: "full",
      execOverrides,
      runId: "run-plugin-clamped-session-permissions",
    });

    expect(execOverrides).toEqual({ mode: "auto" });
  });
});
