// Isolated-gateway trace for delete-cleanup archive retention. Starts a real
// ephemeral gateway (which activates the subagent registry), then drives the
// live completion path: lifecycle end, retained listing, SQLite restart, expiry.
import { afterEach, describe, expect, test, vi } from "vitest";
import { reconcileOrphanedRestoredRuns } from "../agents/subagents/registry/subagent-registry-helpers.js";
import {
  loadSubagentRegistryFromSqlite,
  loadSubagentSessionListRunsFromSqlite,
  saveSubagentRegistryToSqlite,
} from "../agents/subagents/registry/subagent-registry.store.sqlite.js";
import {
  getSubagentRunByRunId,
  listSubagentRunsForRequester,
  registerSubagentRun,
  resetSubagentRegistryForTests,
  testing as subagentRegistryTesting,
} from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import { shouldKeepSubagentRunChildLink } from "../agents/subagents/registry/subagent-run-liveness.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import type { callGateway } from "./call.js";
import { installConnectedSessionStoreGatewaySuite } from "./test-helpers.connected-session-store.js";
import { installGatewayTestHooks, rpcReq, testState, writeSessionStore } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });
const gatewaySuite = installConnectedSessionStoreGatewaySuite(
  "openclaw-gw-delete-cleanup-retention-",
);

const RUN_ID = "run-gw-delete-retention";
const CHILD_SESSION_KEY = "agent:main:subagent:gw-delete-retention";
const REQUESTER_SESSION_KEY = "agent:main:main";

afterEach(() => {
  subagentRegistryTesting.setDepsForTest();
  resetSubagentRegistryForTests({ persist: false });
});

/** Route registry gateway calls at the live ephemeral gateway so cleanup really deletes. */
function useLiveGatewayForRegistryCleanup(): void {
  const callLiveGateway = async (options: { method: string; params?: unknown }) => {
    const res = await rpcReq<Record<string, unknown>>(
      gatewaySuite.ws,
      options.method,
      options.params,
    );
    if (!res.ok) {
      throw new Error(`gateway ${options.method} failed: ${JSON.stringify(res.error)}`);
    }
    return res.payload;
  };
  subagentRegistryTesting.setDepsForTest({
    callGateway: callLiveGateway as unknown as typeof callGateway,
  });
}

describe("delete-cleanup archive retention through a real gateway", () => {
  test("cleanup, retained listing, restart recovery, and expiry", async () => {
    testState.sessionStorePath = gatewaySuite.sessionStorePath;
    useLiveGatewayForRegistryCleanup();
    await writeSessionStore({
      entries: {
        [REQUESTER_SESSION_KEY]: {
          sessionId: "sess-gw-delete-retention-parent",
          updatedAt: Date.now(),
        },
        [CHILD_SESSION_KEY]: {
          sessionId: "sess-gw-delete-retention",
          updatedAt: Date.now(),
          spawnedBy: REQUESTER_SESSION_KEY,
          // Delete cleanup submits sessions.delete only with both lifecycle
          // identities; without the revision it suppresses child-session effects.
          lifecycleRevision: "rev-gw-delete-retention",
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

    // Retention must not leak into session navigation: delete cleanup removed
    // the child session, so the parent must expose no expandable child toggle
    // and the spawnedBy query must stay empty while the run itself stays listed.
    // Delete cleanup dispatches sessions.delete asynchronously; the completion
    // stamp lands only after the live gateway acknowledges the deletion.
    const cleanupCompletedAt = await vi.waitFor(
      () => {
        const completedAt = getSubagentRunByRunId(RUN_ID)?.cleanupCompletedAt;
        expect(completedAt).toBeTypeOf("number");
        return completedAt as number;
      },
      { timeout: 10_000, interval: 25 },
    );

    const listed = await vi.waitFor(async () => {
      const res = await rpcReq<{
        sessions: Array<{ key: string; childSessions?: string[] }>;
      }>(gatewaySuite.ws, "sessions.list", { includeUnknown: true });
      expect(res.ok).toBe(true);
      const keys = res.payload?.sessions.map((row) => row.key) ?? [];
      expect(keys).not.toContain(CHILD_SESSION_KEY);
      return res.payload?.sessions ?? [];
    });
    const parentRow = listed.find((row) => row.key === REQUESTER_SESSION_KEY);
    expect(parentRow).toBeDefined();
    expect(parentRow?.childSessions).toBeUndefined();

    const spawnedChildren = await rpcReq<{ sessions: Array<{ key: string }> }>(
      gatewaySuite.ws,
      "sessions.list",
      { includeUnknown: true, spawnedBy: REQUESTER_SESSION_KEY },
    );
    expect(spawnedChildren.ok).toBe(true);
    expect(spawnedChildren.payload?.sessions ?? []).toEqual([]);

    const afterRestart = loadSubagentRegistryFromSqlite().get(RUN_ID);
    expect(afterRestart?.archiveAtMs).toBe(retained.archiveAtMs);
    expect(afterRestart?.cleanupCompletedAt).toBe(cleanupCompletedAt);
    expect(afterRestart?.deleteCleanupDispatchedAt).toBeTypeOf("number");

    // Interrupted handoff: the process can stop after the live gateway accepted
    // sessions.delete and before cleanup bookkeeping lands. Rebuild exactly that
    // on-disk shape from the real persisted row — dispatch stamp kept, completion
    // stamp gone, child session already deleted — and run the real restore path.
    const interrupted = loadSubagentRegistryFromSqlite();
    const interruptedRow = interrupted.get(RUN_ID);
    expect(interruptedRow).toBeDefined();
    const dispatchedAt = interruptedRow!.deleteCleanupDispatchedAt as number;
    interruptedRow!.cleanupCompletedAt = undefined;
    interruptedRow!.requesterSettleWake = undefined;
    saveSubagentRegistryToSqlite(interrupted);

    const restored = loadSubagentRegistryFromSqlite();
    expect(restored.get(RUN_ID)?.cleanupCompletedAt).toBeUndefined();
    reconcileOrphanedRestoredRuns({ runs: restored, resumedRuns: new Set() });
    const recovered = restored.get(RUN_ID);
    expect(recovered).toBeDefined();
    expect(recovered?.archiveAtMs).toBe(retained.archiveAtMs);
    expect(recovered?.cleanupCompletedAt).toBe(dispatchedAt);

    // The interrupted row must not relink the deleted child in the session list.
    saveSubagentRegistryToSqlite(restored);
    const interruptedProjection = loadSubagentSessionListRunsFromSqlite().get(RUN_ID);
    expect(interruptedProjection).toBeDefined();
    expect(shouldKeepSubagentRunChildLink(interruptedProjection!)).toBe(false);

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
      sessionNavigation: {
        childSessionDeleted: true,
        childSessionListed: false,
        parentChildToggle: parentRow?.childSessions ?? null,
        spawnedByChildren: spawnedChildren.payload?.sessions.length ?? -1,
      },
      restartRecovery: { present: Boolean(afterRestart) },
      interruptedHandoff: {
        dispatchStampPersisted: true,
        completionStampMissingOnDisk: true,
        prunedByRestore: false,
        repairedCleanupCompletedAt: recovered?.cleanupCompletedAt ?? null,
        childLinkAfterRestore: false,
      },
      expiry: { presentAfterSweep: false },
    };
    // Printed so the exact-head PR body can cite the isolated-gateway output.
    console.log(`OPENCLAW_ISOLATED_GATEWAY_VERDICT ${JSON.stringify(verdict)}`);
    expect(verdict.restartRecovery.present).toBe(true);
  });
});
