import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
  patchSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { clearAgentRunContext } from "../infra/agent-run-registry.js";
import type { SubsystemLogger } from "../logging/subsystem.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  createChatRunState,
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
} from "./server-chat-state.js";
import { admitChatSend } from "./server-methods/chat-send-admission.js";
import { handleChatSendSetupError } from "./server-methods/chat-send-dispatch-errors.js";
import { startGatewayEventSubscriptions } from "./server-runtime-subscriptions.js";
import { cancelGatewayWorkerSessionWork } from "./server-worker-placement-cancel.js";
import { createGatewayWorkerPlacementReclaimBarriers } from "./server-worker-placement-reclaim.js";
import { admitWorkerStopChat } from "./server-worker-placement.test-harness.js";
import * as lifecycleState from "./session-lifecycle-state.js";
const routing = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("./session-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-utils.js")>()),
  loadSessionEntry: routing.load,
}));

it.each(["success", "failed-write", "setup-failed-write"] as const)(
  "Stop preserves canonical terminal ownership through %s",
  async (outcome) => {
    const terminalWrite = createDeferred();
    const persistenceSpy =
      outcome === "success"
        ? undefined
        : vi
            .spyOn(lifecycleState, "persistGatewaySessionLifecycleEvent")
            .mockImplementation(() => terminalWrite.promise);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "worker-stop-terminal-"));
    const target = {
      storePath: path.join(root, "sessions.json"),
      sessionKey: "agent:main:terminal-stop",
    };
    const sessionId = "terminal-stop-session";
    const runId = "terminal-stop-run";
    const entry = {
      sessionId,
      worktree: { id: "terminal-worktree", branch: "test", repoRoot: root },
      updatedAt: Date.now(),
    };
    const events: Array<{
      phase: unknown;
      status: unknown;
      aborted: unknown;
      stopReason: unknown;
    }> = [];
    const chatRunState = createChatRunState();
    const log: SubsystemLogger = {
      subsystem: "test-terminal",
      child: () => log,
      isEnabled: () => false,
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      raw: vi.fn(),
    };
    const context = {
      dedupe: new Map(),
      chatRunState,
      chatAbortControllers: new Map(),
      chatQueuedTurns: new Map(),
      agentRunSeq: new Map(),
      getRuntimeConfig: () => ({}),
      removeChatRun: vi.fn(),
      broadcast: vi.fn(),
      nodeSendToSession: vi.fn(),
      cancelRunBoundApprovals: vi.fn(),
      logGateway: log,
    } as unknown as import("./server-methods/types.js").GatewayRequestContext;
    routing.load.mockImplementation(() => ({
      ...target,
      canonicalKey: target.sessionKey,
      cfg: {},
      entry: loadSessionEntry(target),
    }));
    let subscriptions: ReturnType<typeof startGatewayEventSubscriptions> | undefined;
    let heldWriter: Promise<unknown> | undefined;
    let reclaim: Promise<unknown> | undefined;
    const writerEntered = createDeferred();
    const releaseWriter = createDeferred();
    const abortObserved = createDeferred();
    let placement = {
      sessionId,
      sessionKey: target.sessionKey,
      agentId: "main",
      state: "active" as "active" | "reclaimed",
      turnClaim: null,
    };
    let reclaimEffectStarted = false;
    let active: Awaited<ReturnType<typeof admitChatSend>> | undefined;
    const unsubscribe = onAgentEvent((event) => {
      if (event.runId === runId && event.stream === "lifecycle") {
        events.push({
          phase: event.data.phase,
          status: event.data.status,
          aborted: event.data.aborted,
          stopReason: event.data.stopReason,
        });
      }
    });
    const admit = (id: string) =>
      admitWorkerStopChat({
        context,
        storePath: target.storePath,
        sessionKey: target.sessionKey,
        sessionId,
        agentId: "main",
        entry,
        runId: id,
      }).promise;
    try {
      await replaceSessionEntry(target, entry);
      subscriptions = startGatewayEventSubscriptions({
        log,
        broadcast: context.broadcast,
        broadcastToConnIds: vi.fn(),
        nodeSendToSession: context.nodeSendToSession,
        agentRunSeq: context.agentRunSeq,
        chatRunState,
        toolEventRecipients: chatRunState.toolEventRecipients,
        sessionEventSubscribers: createSessionEventSubscriberRegistry(),
        sessionMessageSubscribers: createSessionMessageSubscriberRegistry(),
        chatAbortControllers: context.chatAbortControllers,
        restartRecoveryCandidates: new Map(),
        terminalSessions: { closeTaskSessions: vi.fn() },
      });
      active = await admit(runId);
      expect(active.ok).toBe(true);
      if (!active.ok) {
        throw new Error("active admission missing");
      }
      const owned = active.value;
      await replaceSessionEntry(target, {
        ...entry,
        status: "running",
        lifecycleRunId: runId,
        startedAt: Date.now(),
      });
      owned.activeRunAbort.controller.signal.addEventListener(
        "abort",
        () => {
          if (outcome !== "setup-failed-write") {
            owned.cleanupAdmittedRun();
          }
          abortObserved.resolve();
        },
        { once: true },
      );
      heldWriter = patchSessionEntryCore(target, async () => {
        writerEntered.resolve();
        await releaseWriter.promise;
        return null;
      });
      await writerEntered.promise;
      const sessionTarget = {
        storePath: target.storePath,
        canonicalKey: target.sessionKey,
        storeKeys: [target.sessionKey],
        agentId: "main",
        store: { [target.sessionKey]: entry },
      };
      const barriers = createGatewayWorkerPlacementReclaimBarriers({
        placements: { get: () => placement as never, waitForTurnClaimRelease: async () => {} },
        loadSessionRuntime: async () =>
          ({
            managedWorktrees: {
              findLiveByOwner: () => ({
                id: "terminal-worktree",
                ownerId: target.sessionKey,
                path: root,
              }),
            },
            resolveGatewaySessionStoreTargetWithStore: () => sessionTarget,
            resolveCanonicalSessionEntryFromStoreKeys: () => entry,
          }) as never,
        cancelSessionWork: (request) => cancelGatewayWorkerSessionWork(context, request),
        revokeSessionAuthority: vi.fn(),
      });
      reclaim = barriers.runReclaimBarrier({
        sessionId,
        sessionKey: target.sessionKey,
        agentId: "main",
        begin: () => ({ ...placement, state: "draining" }) as never,
        reclaim: async () => {
          reclaimEffectStarted = true;
          expect(loadSessionEntry(target)).toMatchObject({
            status: "killed",
            lastRunId: runId,
            abortedLastRun: true,
          });
          placement = { ...placement, state: "reclaimed" };
          return placement as never;
        },
      });
      await abortObserved.promise;
      expect(context.chatAbortControllers.has(runId)).toBe(true);
      expect(owned.activeRunAbort.entry?.projectSessionTerminalPersistence).toBeInstanceOf(Promise);
      expect(reclaimEffectStarted).toBe(false);
      expect(loadSessionEntry(target)?.status).toBe("running");
      const late = await admit("during-terminal-write");
      expect(late.ok).toBe(false);
      expect(
        (
          context.dedupe.get("chat:during-terminal-write")?.payload as
            | { summary?: string }
            | undefined
        )?.summary,
      ).toBe("aborted");
      if (outcome === "setup-failed-write") {
        expect(owned.restartSafeAdmission).toBeUndefined();
        await handleChatSendSetupError({
          admission: owned,
          context,
          error: new Error("pre-ACK reply context failed"),
          respond: vi.fn(),
          session: { agentId: "main", clientRunId: runId, sessionKey: target.sessionKey },
          terminalizeRestartSafeAdmission: vi.fn(async () => false),
        });
        expect(context.chatAbortControllers.get(runId)).toBe(owned.activeRunAbort.entry);
        expect(reclaimEffectStarted).toBe(false);
      }
      if (outcome !== "success") {
        const rejected = expect(reclaim).rejects.toThrow("Session cancellation did not persist");
        terminalWrite.reject(new Error("terminal store unavailable"));
        releaseWriter.resolve();
        await heldWriter;
        await rejected;
        expect(reclaimEffectStarted).toBe(false);
        expect(loadSessionEntry(target)?.status).toBe("running");
        return;
      }
      releaseWriter.resolve();
      await heldWriter;
      await reclaim;
      expect(events.filter((event) => event.phase === "end")).toEqual([
        { phase: "end", status: "cancelled", aborted: true, stopReason: "rpc" },
      ]);
      expect(context.chatAbortControllers.has(runId)).toBe(false);
      closeOpenClawAgentDatabasesForTest();
      const persisted = loadSessionEntry({ ...target, readConsistency: "latest" });
      expect(persisted).toMatchObject({ status: "killed", lastRunId: runId, abortedLastRun: true });
      expect(persisted?.endedAt).toBeTypeOf("number");
      const fresh = await admit("explicit-after-terminal-stop");
      expect(fresh.ok).toBe(true);
      if (fresh.ok) {
        fresh.value.cleanupAdmittedRun();
        clearAgentRunContext("explicit-after-terminal-stop", fresh.value.lifecycleGeneration);
      }
    } finally {
      terminalWrite.resolve();
      releaseWriter.resolve();
      await heldWriter;
      await reclaim?.catch(() => {});
      if (active?.ok) {
        active.value.cleanupAdmittedRun();
        clearAgentRunContext(runId, active.value.lifecycleGeneration);
      }
      unsubscribe();
      await subscriptions?.agentUnsub();
      subscriptions?.heartbeatUnsub();
      subscriptions?.transcriptUnsub();
      subscriptions?.lifecycleUnsub();
      await subscriptions?.taskUnsub();
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      persistenceSpy?.mockRestore();
      routing.load.mockReset();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
