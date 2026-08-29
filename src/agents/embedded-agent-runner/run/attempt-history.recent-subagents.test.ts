// Two-turn parent-agent trace through prepareEmbeddedAttemptHistory, the
// production seam that prepends subagent prompt context before the model runs.
import { beforeEach, describe, expect, it } from "vitest";
import type { SubagentRunRecordOverrides } from "../../subagent-test-fixtures.test-helpers.js";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "../../subagents/registry/subagent-registry.test-helpers.js";
import {
  assembleParentTurnSystemPrompt,
  excerptRecentlyCompletedBlock,
  PARENT_TURN_BASE_SYSTEM_PROMPT,
} from "./attempt-history-parent-prompt.test-helpers.js";

const PARENT_SESSION_KEY = "agent:main:main";
const CHILD_SESSION_KEY = "agent:main:subagent:attempt-history-recent";
const RUN_ID = "run-attempt-history-recent";

beforeEach(() => {
  resetSubagentRegistryForTests();
});

describe("prepareEmbeddedAttemptHistory recently completed subagents", () => {
  it("assembles the recent-state prompt on the later parent turn only", async () => {
    const firstParentTurn = await assembleParentTurnSystemPrompt({
      sessionKey: PARENT_SESSION_KEY,
    });
    expect(firstParentTurn).toBeUndefined();

    const endedAt = Date.now() - 15_000;
    addSubagentRunForTests({
      runId: RUN_ID,
      childSessionKey: CHILD_SESSION_KEY,
      controllerSessionKey: PARENT_SESSION_KEY,
      requesterSessionKey: PARENT_SESSION_KEY,
      requesterDisplayKey: "main",
      task: "summarize the inbox",
      taskName: "summarize_inbox",
      cleanup: "keep",
      createdAt: endedAt - 60_000,
      startedAt: endedAt - 60_000,
      endedAt,
      outcome: { status: "ok" },
    } satisfies SubagentRunRecordOverrides);

    const laterParentTurn = await assembleParentTurnSystemPrompt({
      sessionKey: PARENT_SESSION_KEY,
    });
    expect(laterParentTurn).toContain(PARENT_TURN_BASE_SYSTEM_PROMPT);
    expect(laterParentTurn).toContain("## Recently Completed Subagents");
    expect(laterParentTurn).toContain(`run=${RUN_ID}`);
    expect(laterParentTurn).toContain(`session=${CHILD_SESSION_KEY}`);
    expect(laterParentTurn).not.toContain("## Active Subagents");

    const assembledRecentPrompt = excerptRecentlyCompletedBlock(laterParentTurn);
    const verdict = {
      surface: "parent-agent-turn",
      path: "prepareEmbeddedAttemptHistory",
      firstParentTurn: { assembledPrompt: firstParentTurn ?? null },
      completion: { runId: RUN_ID, terminal: true },
      laterParentTurn: {
        hasRecentlyCompleted: assembledRecentPrompt !== null,
        runId: RUN_ID,
        assembledRecentPrompt,
      },
    };
    // Printed so the exact-head PR body can cite the parent-turn assembly output.
    console.log(`OPENCLAW_PARENT_TURN_VERDICT ${JSON.stringify(verdict)}`);
    expect(verdict.laterParentTurn.hasRecentlyCompleted).toBe(true);
  });
});
