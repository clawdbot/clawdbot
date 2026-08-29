// Isolated-gateway two-turn parent-agent trace. A real ephemeral gateway
// activates the registry and completes a keep-cleanup child; each parent turn
// is then assembled through prepareEmbeddedAttemptHistory, the production
// seam that prepends the recent-state block before the model runs.
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  assembleParentTurnSystemPrompt,
  excerptRecentlyCompletedBlock,
  PARENT_TURN_BASE_SYSTEM_PROMPT,
} from "../agents/embedded-agent-runner/run/attempt-history-parent-prompt.test-helpers.js";
import {
  listSubagentRunsForRequester,
  registerSubagentRun,
  resetSubagentRegistryForTests,
} from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { installConnectedSessionStoreGatewaySuite } from "./test-helpers.connected-session-store.js";
import { installGatewayTestHooks, testState, writeSessionStore } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });
const gatewaySuite = installConnectedSessionStoreGatewaySuite(
  "openclaw-gw-subagent-prompt-recent-",
);

const RUN_ID = "run-gw-prompt-recent";
const CHILD_SESSION_KEY = "agent:main:subagent:gw-prompt-recent";
const PARENT_SESSION_KEY = "agent:main:main";

afterEach(() => {
  resetSubagentRegistryForTests({ persist: false });
});

describe("Recently Completed Subagents prompt block through a real gateway", () => {
  test("parent spawn, completion, and later-turn prompt", async () => {
    testState.sessionStorePath = gatewaySuite.sessionStorePath;
    await writeSessionStore({
      entries: {
        [CHILD_SESSION_KEY]: {
          sessionId: "sess-gw-prompt-recent",
          updatedAt: Date.now(),
        },
      },
    });

    const firstParentTurn = await assembleParentTurnSystemPrompt({
      sessionKey: PARENT_SESSION_KEY,
    });
    expect(firstParentTurn).toBeUndefined();

    registerSubagentRun({
      runId: RUN_ID,
      childSessionKey: CHILD_SESSION_KEY,
      requesterSessionKey: PARENT_SESSION_KEY,
      requesterDisplayKey: "main",
      task: "summarize the inbox",
      taskName: "summarize_inbox",
      cleanup: "keep",
      expectsCompletionMessage: false,
    });

    const endedAt = Date.now();
    emitAgentEvent({
      runId: RUN_ID,
      stream: "lifecycle",
      data: { phase: "end", endedAt, terminalReply: { disposition: "visible", text: "done" } },
    });

    await vi.waitFor(() => {
      const entry = listSubagentRunsForRequester(PARENT_SESSION_KEY).find(
        (row) => row.runId === RUN_ID,
      );
      expect(entry?.execution.status).toBe("terminal");
      expect(entry?.execution.endedAt).toBeTypeOf("number");
    });

    const laterParentTurn = await assembleParentTurnSystemPrompt({
      sessionKey: PARENT_SESSION_KEY,
    });
    expect(laterParentTurn).toContain(PARENT_TURN_BASE_SYSTEM_PROMPT);
    expect(laterParentTurn).toContain("## Recently Completed Subagents");
    expect(laterParentTurn).toContain(`run=${RUN_ID}`);
    expect(laterParentTurn).toContain(`session=${CHILD_SESSION_KEY}`);
    expect(laterParentTurn).toContain("taskName=summarize_inbox");
    expect(laterParentTurn).not.toContain("## Active Subagents");

    const assembledRecentPrompt = excerptRecentlyCompletedBlock(laterParentTurn);
    const verdict = {
      surface: "isolated-gateway",
      path: "prepareEmbeddedAttemptHistory",
      firstParentTurn: { assembledPrompt: firstParentTurn ?? null },
      completion: { runId: RUN_ID, terminal: true },
      laterParentTurn: {
        hasRecentlyCompleted: assembledRecentPrompt !== null,
        runId: RUN_ID,
        assembledRecentPrompt,
      },
    };
    // Printed so the exact-head PR body can cite the isolated-gateway output.
    console.log(`OPENCLAW_ISOLATED_GATEWAY_VERDICT ${JSON.stringify(verdict)}`);
    expect(verdict.laterParentTurn.hasRecentlyCompleted).toBe(true);
  });
});
