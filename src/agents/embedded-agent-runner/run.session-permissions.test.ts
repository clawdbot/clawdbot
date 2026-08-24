import { describe, expect, it } from "vitest";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
} from "./run.overflow-compaction.harness.js";

describe("embedded run session permissions", () => {
  it("prepares the exec mode with plugin-owned permission facts", async () => {
    const { runEmbeddedAgent } = await loadRunOverflowCompactionHarness();
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ assistantTexts: ["OK"] }));

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      permissionMode: "workspace",
      sessionRoot: "/tmp/openclaw-plugin-session-root",
      runId: "run-plugin-session-permissions",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        execOverrides: expect.objectContaining({ mode: "auto" }),
        permissionMode: "workspace",
        sessionRoot: "/tmp/openclaw-plugin-session-root",
      }),
    );
  });

  it("shares the final plugin-clamped exec mode with the outer run", async () => {
    const { runEmbeddedAgent } = await loadRunOverflowCompactionHarness();
    const execOverrides = {};
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (attempt) => {
      expect(attempt.execOverrides).toBe(execOverrides);
      expect(attempt.execOverrides?.mode).toBe("full");
      attempt.permissionMode = "workspace";
      attempt.execOverrides!.mode = "auto";
      return makeAttemptResult({ assistantTexts: ["OK"] });
    });

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      permissionMode: "full",
      sessionRoot: "/tmp/openclaw-plugin-session-root",
      execOverrides,
      runId: "run-plugin-clamped-session-permissions",
    });

    expect(execOverrides).toEqual({ mode: "auto" });
  });
});
