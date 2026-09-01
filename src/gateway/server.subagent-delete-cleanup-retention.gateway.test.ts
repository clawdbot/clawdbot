// Isolated-gateway trace for delete-cleanup archive retention. Starts a real
// ephemeral gateway (which activates the subagent registry), then drives the
// live completion path: lifecycle end, retained listing, SQLite restart, expiry.
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  persistSubagentRunsToDisk,
  persistSubagentRunsToDiskOrThrow,
} from "../agents/subagents/registry/subagent-registry-state.js";
import {
  loadSubagentRegistryFromSqlite,
  loadSubagentSessionListRunsFromSqlite,
  saveSubagentRegistryToSqlite,
} from "../agents/subagents/registry/subagent-registry.store.sqlite.js";
import {
  activateSubagentRegistry,
  getSubagentRunByRunId,
  initSubagentRegistry,
  listSubagentRunsForRequester,
  registerSubagentRun,
  resetSubagentRegistryForTests,
  testing as subagentRegistryTesting,
} from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
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
    // stamp gone, child session already deleted — then restore + activate.
    const interrupted = loadSubagentRegistryFromSqlite();
    const interruptedRow = interrupted.get(RUN_ID);
    expect(interruptedRow).toBeDefined();
    const dispatchedAt = interruptedRow!.deleteCleanupDispatchedAt as number;
    interruptedRow!.cleanupCompletedAt = undefined;
    interruptedRow!.requesterSettleWake = undefined;
    saveSubagentRegistryToSqlite(interrupted);

    resetSubagentRegistryForTests({ persist: false });
    useLiveGatewayForRegistryCleanup();
    initSubagentRegistry();
    expect(getSubagentRunByRunId(RUN_ID)?.cleanupCompletedAt).toBeUndefined();
    activateSubagentRegistry(
      () =>
        ({
          recoveryRuntime: {
            dispatchAgent: vi.fn(),
            waitForAgent: vi.fn(),
            sendRecoveryNotice: vi.fn(),
          },
        }) as never,
    );
    const recovered = await vi.waitFor(
      () => {
        const entry = getSubagentRunByRunId(RUN_ID);
        expect(entry?.archiveAtMs).toBe(retained.archiveAtMs);
        expect(entry?.cleanupCompletedAt).toBeTypeOf("number");
        return entry!;
      },
      { timeout: 10_000, interval: 25 },
    );
    // Owner finalize uses Date.now(), not the dispatch stamp. Settle wake may
    // already have drained by the time we observe the row.
    expect(recovered.cleanupCompletedAt).not.toBe(dispatchedAt);

    // The interrupted row must not relink the deleted child in the session list.
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
        finalizedByRestoreActivation: recovered.cleanupCompletedAt !== dispatchedAt,
        childLinkAfterRestore: false,
      },
      expiry: { presentAfterSweep: false },
    };
    // Printed so the exact-head PR body can cite the isolated-gateway output.
    console.log(`OPENCLAW_ISOLATED_GATEWAY_VERDICT ${JSON.stringify(verdict)}`);
    expect(verdict.restartRecovery.present).toBe(true);
  });

  test("keeps parent navigation when guarded sessions.delete is rejected as session-changed", async () => {
    testState.sessionStorePath = gatewaySuite.sessionStorePath;
    const parentSessionId = "sess-gw-delete-changed-parent";
    const childSessionId = "sess-gw-delete-changed";
    const originalRevision = "rev-gw-delete-changed";
    const successorRevision = "rev-gw-delete-changed-successor";
    const childSessionKey = `${CHILD_SESSION_KEY}-changed`;
    const runId = `${RUN_ID}-changed`;

    const callLiveGateway = async (options: { method: string; params?: unknown }) => {
      if (options.method === "sessions.delete") {
        await writeSessionStore({
          entries: {
            [REQUESTER_SESSION_KEY]: {
              sessionId: parentSessionId,
              updatedAt: Date.now(),
            },
            [childSessionKey]: {
              sessionId: childSessionId,
              updatedAt: Date.now(),
              spawnedBy: REQUESTER_SESSION_KEY,
              lifecycleRevision: successorRevision,
            },
          },
        });
      }
      const res = await rpcReq<Record<string, unknown>>(
        gatewaySuite.ws,
        options.method,
        options.params,
      );
      if (!res.ok) {
        throw Object.assign(new Error(res.error?.message ?? `gateway ${options.method} failed`), {
          name: "GatewayClientRequestError",
          gatewayCode: res.error?.code ?? "INVALID_REQUEST",
          details: res.error?.details,
        });
      }
      return res.payload;
    };
    subagentRegistryTesting.setDepsForTest({
      callGateway: callLiveGateway as unknown as typeof callGateway,
    });

    await writeSessionStore({
      entries: {
        [REQUESTER_SESSION_KEY]: {
          sessionId: parentSessionId,
          updatedAt: Date.now(),
        },
        [childSessionKey]: {
          sessionId: childSessionId,
          updatedAt: Date.now(),
          spawnedBy: REQUESTER_SESSION_KEY,
          lifecycleRevision: originalRevision,
        },
      },
    });

    registerSubagentRun({
      runId,
      childSessionKey,
      requesterSessionKey: REQUESTER_SESSION_KEY,
      requesterDisplayKey: "main",
      task: "stay listed after rejected delete cleanup",
      cleanup: "delete",
      expectsCompletionMessage: false,
    });

    emitAgentEvent({
      runId,
      stream: "lifecycle",
      data: {
        phase: "end",
        endedAt: Date.now(),
        terminalReply: { disposition: "visible", text: "done" },
      },
    });

    const retained = await vi.waitFor(
      () => {
        const entry = getSubagentRunByRunId(runId);
        expect(entry?.cleanupCompletedAt).toBeTypeOf("number");
        expect(entry?.execution.suppressSessionEffects).toBe(true);
        expect(entry?.deleteCleanupDispatchedAt).toBeUndefined();
        return entry!;
      },
      { timeout: 10_000, interval: 25 },
    );

    const listed = await vi.waitFor(async () => {
      const res = await rpcReq<{
        sessions: Array<{ key: string; childSessions?: string[] }>;
      }>(gatewaySuite.ws, "sessions.list", { includeUnknown: true });
      expect(res.ok).toBe(true);
      const keys = res.payload?.sessions.map((row) => row.key) ?? [];
      expect(keys).toContain(childSessionKey);
      return res.payload?.sessions ?? [];
    });
    const parentRow = listed.find((row) => row.key === REQUESTER_SESSION_KEY);
    expect(parentRow?.childSessions).toEqual([childSessionKey]);
    expect(shouldKeepSubagentRunChildLink(retained)).toBe(true);

    const verdict = {
      surface: "isolated-gateway",
      path: "delete-cleanup session-changed rejection",
      sessionNavigation: {
        childSessionDeleted: false,
        childSessionListed: true,
        parentChildToggle: parentRow?.childSessions ?? null,
        dispatchStampCleared: retained.deleteCleanupDispatchedAt === undefined,
      },
    };
    console.log(`OPENCLAW_ISOLATED_GATEWAY_VERDICT ${JSON.stringify(verdict)}`);
  });

  test("does not delete a successor after session-changed persist fails and registry restarts", async () => {
    testState.sessionStorePath = gatewaySuite.sessionStorePath;
    const parentSessionId = "sess-gw-delete-restart-parent";
    const childSessionId = "sess-gw-delete-restart";
    const originalRevision = "rev-gw-delete-restart";
    const successorRevision = "rev-gw-delete-restart-successor";
    const childSessionKey = `${CHILD_SESSION_KEY}-restart`;
    const runId = `${RUN_ID}-restart`;
    let failClearPersist = true;
    const deletedRevisions: string[] = [];

    const callLiveGateway = async (options: { method: string; params?: unknown }) => {
      if (options.method === "sessions.delete") {
        const expectedRevision = (
          options.params as { expectedLifecycleRevision?: string } | undefined
        )?.expectedLifecycleRevision;
        if (expectedRevision) {
          deletedRevisions.push(expectedRevision);
        }
        await writeSessionStore({
          entries: {
            [REQUESTER_SESSION_KEY]: {
              sessionId: parentSessionId,
              updatedAt: Date.now(),
            },
            [childSessionKey]: {
              sessionId: childSessionId,
              updatedAt: Date.now(),
              spawnedBy: REQUESTER_SESSION_KEY,
              lifecycleRevision: successorRevision,
            },
          },
        });
      }
      const res = await rpcReq<Record<string, unknown>>(
        gatewaySuite.ws,
        options.method,
        options.params,
      );
      if (!res.ok) {
        throw Object.assign(new Error(res.error?.message ?? `gateway ${options.method} failed`), {
          name: "GatewayClientRequestError",
          gatewayCode: res.error?.code ?? "INVALID_REQUEST",
          details: res.error?.details,
        });
      }
      return res.payload;
    };

    subagentRegistryTesting.setDepsForTest({
      callGateway: callLiveGateway as unknown as typeof callGateway,
      persistSubagentRunsToDisk: (runs, ids) => {
        const row = runs.get(runId);
        if (
          failClearPersist &&
          row?.deleteCleanupDispatchedAt === undefined &&
          row?.deleteCleanupTarget === undefined
        ) {
          // Process crash before later best-effort persistence of the
          // in-memory session-changed fence.
          return;
        }
        persistSubagentRunsToDisk(runs, ids);
      },
      persistSubagentRunsToDiskOrThrow: (runs, ids) => {
        const row = runs.get(runId);
        if (
          failClearPersist &&
          row?.deleteCleanupDispatchedAt === undefined &&
          row?.deleteCleanupTarget === undefined &&
          row?.execution.suppressSessionEffects === true
        ) {
          throw new Error("registry store boom");
        }
        persistSubagentRunsToDiskOrThrow(runs, ids);
      },
    });

    await writeSessionStore({
      entries: {
        [REQUESTER_SESSION_KEY]: {
          sessionId: parentSessionId,
          updatedAt: Date.now(),
        },
        [childSessionKey]: {
          sessionId: childSessionId,
          updatedAt: Date.now(),
          spawnedBy: REQUESTER_SESSION_KEY,
          lifecycleRevision: originalRevision,
        },
      },
    });

    registerSubagentRun({
      runId,
      childSessionKey,
      requesterSessionKey: REQUESTER_SESSION_KEY,
      requesterDisplayKey: "main",
      task: "keep successor after failed session-changed persist",
      cleanup: "delete",
      expectsCompletionMessage: false,
    });

    emitAgentEvent({
      runId,
      stream: "lifecycle",
      data: {
        phase: "end",
        endedAt: Date.now(),
        terminalReply: { disposition: "visible", text: "done" },
      },
    });

    const dispatched = await vi.waitFor(() => {
      const disk = loadSubagentRegistryFromSqlite().get(runId);
      expect(disk?.deleteCleanupDispatchedAt).toBeTypeOf("number");
      expect(disk?.deleteCleanupTarget).toEqual({
        sessionId: childSessionId,
        lifecycleRevision: originalRevision,
      });
      expect(getSubagentRunByRunId(runId)?.execution.suppressSessionEffects).toBe(true);
      return disk!;
    });

    failClearPersist = false;
    resetSubagentRegistryForTests({ persist: false });
    subagentRegistryTesting.setDepsForTest({
      callGateway: callLiveGateway as unknown as typeof callGateway,
    });
    initSubagentRegistry();
    expect(getSubagentRunByRunId(runId)?.deleteCleanupTarget).toEqual(
      dispatched.deleteCleanupTarget,
    );
    activateSubagentRegistry(
      () =>
        ({
          recoveryRuntime: {
            dispatchAgent: vi.fn(),
            waitForAgent: vi.fn(),
            sendRecoveryNotice: vi.fn(),
          },
        }) as never,
    );

    const recovered = await vi.waitFor(
      () => {
        const entry = getSubagentRunByRunId(runId);
        expect(entry?.cleanupCompletedAt).toBeTypeOf("number");
        expect(entry?.deleteCleanupDispatchedAt).toBeUndefined();
        expect(entry?.deleteCleanupTarget).toBeUndefined();
        return entry!;
      },
      { timeout: 10_000, interval: 25 },
    );

    const listed = await vi.waitFor(async () => {
      const res = await rpcReq<{
        sessions: Array<{ key: string; childSessions?: string[] }>;
      }>(gatewaySuite.ws, "sessions.list", { includeUnknown: true });
      expect(res.ok).toBe(true);
      const keys = res.payload?.sessions.map((row) => row.key) ?? [];
      expect(keys).toContain(childSessionKey);
      return res.payload?.sessions ?? [];
    });
    const parentRow = listed.find((row) => row.key === REQUESTER_SESSION_KEY);
    expect(parentRow?.childSessions).toContain(childSessionKey);
    expect(shouldKeepSubagentRunChildLink(recovered)).toBe(true);
    expect(deletedRevisions.every((revision) => revision === originalRevision)).toBe(true);
    expect(deletedRevisions.length).toBeGreaterThanOrEqual(1);

    const verdict = {
      surface: "isolated-gateway",
      path: "delete-cleanup session-changed persist-fail restart",
      sessionNavigation: {
        childSessionDeleted: false,
        childSessionListed: true,
        parentChildToggle: parentRow?.childSessions ?? null,
        deletedRevisions,
        persistedDispatchTarget: dispatched.deleteCleanupTarget,
      },
    };
    console.log(`OPENCLAW_ISOLATED_GATEWAY_VERDICT ${JSON.stringify(verdict)}`);
  });

  test("does not delete a successor when restoring a stamp-only pre-upgrade dispatch", async () => {
    testState.sessionStorePath = gatewaySuite.sessionStorePath;
    const parentSessionId = "sess-gw-stamp-only-parent";
    const successorSessionId = "sess-gw-stamp-only-successor";
    const successorRevision = "rev-gw-stamp-only-successor";
    const childSessionKey = `${CHILD_SESSION_KEY}-stamp-only`;
    const runId = `${RUN_ID}-stamp-only`;
    const now = Date.now();
    const deletedRevisions: string[] = [];

    await writeSessionStore({
      entries: {
        [REQUESTER_SESSION_KEY]: {
          sessionId: parentSessionId,
          updatedAt: now,
        },
        [childSessionKey]: {
          sessionId: successorSessionId,
          updatedAt: now,
          spawnedBy: REQUESTER_SESSION_KEY,
          lifecycleRevision: successorRevision,
        },
      },
    });

    const stampOnlyRun: SubagentRunRecord = {
      runId,
      childSessionKey,
      requesterSessionKey: REQUESTER_SESSION_KEY,
      requesterDisplayKey: "main",
      task: "keep successor after stamp-only restore",
      cleanup: "delete",
      createdAt: now - 100,
      expectsCompletionMessage: false,
      cleanupHandled: true,
      deleteCleanupDispatchedAt: now,
      archiveAtMs: now + 60_000,
      execution: {
        status: "terminal",
        startedAt: now - 50,
        endedAt: now,
        outcome: { status: "ok" },
      },
      completion: { required: false },
      delivery: { status: "not_required" },
    };
    saveSubagentRegistryToSqlite(new Map([[runId, stampOnlyRun]]));

    const callLiveGateway = async (options: { method: string; params?: unknown }) => {
      if (options.method === "sessions.delete") {
        const expectedRevision = (
          options.params as { expectedLifecycleRevision?: string } | undefined
        )?.expectedLifecycleRevision;
        if (expectedRevision) {
          deletedRevisions.push(expectedRevision);
        }
      }
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
    resetSubagentRegistryForTests({ persist: false });
    subagentRegistryTesting.setDepsForTest({
      callGateway: callLiveGateway as unknown as typeof callGateway,
    });
    initSubagentRegistry();
    expect(getSubagentRunByRunId(runId)?.deleteCleanupDispatchedAt).toBeTypeOf("number");
    expect(getSubagentRunByRunId(runId)?.deleteCleanupTarget).toBeUndefined();
    activateSubagentRegistry(
      () =>
        ({
          recoveryRuntime: {
            dispatchAgent: vi.fn(),
            waitForAgent: vi.fn(),
            sendRecoveryNotice: vi.fn(),
          },
        }) as never,
    );

    const recovered = await vi.waitFor(
      () => {
        const entry = getSubagentRunByRunId(runId);
        expect(entry?.cleanupCompletedAt).toBeTypeOf("number");
        expect(entry?.deleteCleanupDispatchedAt).toBeTypeOf("number");
        expect(entry?.deleteCleanupTarget).toBeUndefined();
        return entry!;
      },
      { timeout: 10_000, interval: 25 },
    );

    const listed = await vi.waitFor(async () => {
      const res = await rpcReq<{
        sessions: Array<{ key: string; childSessions?: string[] }>;
      }>(gatewaySuite.ws, "sessions.list", { includeUnknown: true });
      expect(res.ok).toBe(true);
      const keys = res.payload?.sessions.map((row) => row.key) ?? [];
      expect(keys).toContain(childSessionKey);
      return res.payload?.sessions ?? [];
    });
    const parentRow = listed.find((row) => row.key === REQUESTER_SESSION_KEY);
    expect(parentRow).toBeDefined();
    // Stamp-only is a pre-upgrade no-delete fence. The leftover stamp
    // hides the registry child link; the live successor still lists.
    expect(parentRow?.childSessions).toBeUndefined();
    expect(shouldKeepSubagentRunChildLink(recovered)).toBe(false);
    expect(deletedRevisions).toEqual([]);

    const verdict = {
      surface: "isolated-gateway",
      path: "delete-cleanup stamp-only upgrade restart",
      sessionNavigation: {
        childSessionDeleted: false,
        childSessionListed: true,
        parentChildToggle: parentRow?.childSessions ?? null,
        deletedRevisions,
        persistedDispatchTarget: recovered.deleteCleanupTarget ?? null,
      },
    };
    console.log(`OPENCLAW_ISOLATED_GATEWAY_VERDICT ${JSON.stringify(verdict)}`);
  });
});
