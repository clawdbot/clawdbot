// Isolated-gateway trace for the Recently Completed Subagents parent-prompt
// block. A real ephemeral gateway activates the subagent registry; the test
// then drives the exact production seam attempt-history calls
// (buildActiveSubagentSystemPromptAddition):
//   parent turn 1 (no children) -> no prompt block
//   keep-cleanup child completes -> later parent turn lists it
import { afterEach, describe, expect, test, vi } from "vitest";
import { buildActiveSubagentSystemPromptAddition } from "../agents/subagents/registry/subagent-active-context.js";
import {
  listSubagentRunsForRequester,
  registerSubagentRun,
  resetSubagentRegistryForTests,
} from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
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
const emptyCfg = {} as OpenClawConfig;

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

    const firstParentTurn = buildActiveSubagentSystemPromptAddition({
      cfg: emptyCfg,
      controllerSessionKey: PARENT_SESSION_KEY,
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

    const laterParentTurn = buildActiveSubagentSystemPromptAddition({
      cfg: emptyCfg,
      controllerSessionKey: PARENT_SESSION_KEY,
    });
    expect(laterParentTurn).toContain("## Recently Completed Subagents");
    expect(laterParentTurn).toContain(`run=${RUN_ID}`);
    expect(laterParentTurn).toContain(`session=${CHILD_SESSION_KEY}`);
    expect(laterParentTurn).toContain("taskName=summarize_inbox");
    expect(laterParentTurn).not.toContain("## Active Subagents");

    const verdict = {
      surface: "isolated-gateway",
      path: "recently-completed parent prompt",
      firstParentTurn: { promptBlock: firstParentTurn ?? null },
      completion: { runId: RUN_ID, terminal: true },
      laterParentTurn: {
        hasRecentlyCompleted: laterParentTurn?.includes("## Recently Completed Subagents") === true,
        runId: RUN_ID,
      },
    };
    // Printed so the exact-head PR body can cite the isolated-gateway output.
    console.log(`OPENCLAW_ISOLATED_GATEWAY_VERDICT ${JSON.stringify(verdict)}`);
    expect(verdict.laterParentTurn.hasRecentlyCompleted).toBe(true);
  });
});
