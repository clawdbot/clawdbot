// Isolated-gateway trace for delete-cleanup archive retention. Starts a real
// ephemeral gateway (which activates the subagent registry), then drives the
// live completion path: lifecycle end, retained listing, SQLite restart, expiry.
import { afterEach, describe, expect, test, vi } from "vitest";
import { loadSubagentRegistryFromSqlite } from "../agents/subagents/registry/subagent-registry.store.sqlite.js";
import {
  getSubagentRunByRunId,
  listSubagentRunsForRequester,
  registerSubagentRun,
  resetSubagentRegistryForTests,
  testing as subagentRegistryTesting,
} from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { installConnectedSessionStoreGatewaySuite } from "./test-helpers.connected-session-store.js";
import { installGatewayTestHooks, testState, writeSessionStore } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });
const gatewaySuite = installConnectedSessionStoreGatewaySuite(
  "openclaw-gw-delete-cleanup-retention-",
);

const RUN_ID = "run-gw-delete-retention";
const CHILD_SESSION_KEY = "agent:main:subagent:gw-delete-retention";
const REQUESTER_SESSION_KEY = "agent:main:main";

afterEach(() => {
  resetSubagentRegistryForTests({ persist: false });
});

describe("delete-cleanup archive retention through a real gateway", () => {
  test("cleanup, retained listing, restart recovery, and expiry", async () => {
    testState.sessionStorePath = gatewaySuite.sessionStorePath;
    await writeSessionStore({
      entries: {
        [CHILD_SESSION_KEY]: {
          sessionId: "sess-gw-delete-retention",
          updatedAt: Date.now(),
        },
      },
    });

    registerSubagentRun({
      runId: RUN_ID,
      childSessionKey: CHILD_SESSION_KEY,
      requesterSessionKey: REQUESTER_SESSION_KEY,
      requesterDisplayKey: "main",
      task: "stay listed after delete cleanup",
      cleanup: "delete",
      expectsCompletionMessage: false,
    });

    const endedAt = Date.now();
    emitAgentEvent({
      runId: RUN_ID,
      stream: "lifecycle",
      data: { phase: "end", endedAt, terminalReply: { disposition: "visible", text: "done" } },
    });

    const retained = await vi.waitFor(() => {
      const entry = listSubagentRunsForRequester(REQUESTER_SESSION_KEY).find(
        (row) => row.runId === RUN_ID,
      );
      expect(entry?.execution.status).toBe("terminal");
      expect(entry?.archiveAtMs).toBeTypeOf("number");
      expect((entry?.archiveAtMs ?? 0) > endedAt).toBe(true);
      return entry!;
    });

    const afterRestart = loadSubagentRegistryFromSqlite().get(RUN_ID);
    expect(afterRestart?.archiveAtMs).toBe(retained.archiveAtMs);
    expect(afterRestart?.cleanupCompletedAt ?? afterRestart?.execution.endedAt).toBeTypeOf(
      "number",
    );

    // Expire the live map row the sweeper reads. Listing snapshots are clones.
    const live = getSubagentRunByRunId(RUN_ID);
    expect(live).toBeDefined();
    live!.archiveAtMs = endedAt - 1;
    if (live?.delivery && live.delivery.status !== "delivered") {
      live.delivery.status = "delivered";
      live.delivery.deliveredAt = endedAt;
    }
    // Settle-wake rows are skipped by the sweeper until that outbox resolves.
    // The isolated gateway has no parent turn to drain it, so release it here
    // and let the existing archive deadline own retirement.
    live!.requesterSettleWake = undefined;
    await subagentRegistryTesting.sweepOnceForTests();
    await vi.waitFor(() => {
      expect(
        listSubagentRunsForRequester(REQUESTER_SESSION_KEY).some((row) => row.runId === RUN_ID),
      ).toBe(false);
    });

    const verdict = {
      surface: "isolated-gateway",
      path: "delete-cleanup archive retention",
      cleanup: { terminal: true, archiveAtMs: retained.archiveAtMs },
      retainedListing: { runId: RUN_ID, visible: true },
      restartRecovery: { present: Boolean(afterRestart) },
      expiry: { presentAfterSweep: false },
    };
    // Printed so the exact-head PR body can cite the isolated-gateway output.
    console.log(`OPENCLAW_ISOLATED_GATEWAY_VERDICT ${JSON.stringify(verdict)}`);
    expect(verdict.restartRecovery.present).toBe(true);
  });
});
