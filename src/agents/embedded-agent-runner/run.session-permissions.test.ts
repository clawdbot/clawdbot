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
});
