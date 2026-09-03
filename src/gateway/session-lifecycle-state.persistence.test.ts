import path from "node:path";
import { expect, it, vi, type MockInstance } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createAgentLifecycleTerminalBackstop } from "../auto-reply/reply/agent-lifecycle-terminal.js";
import { setRuntimeConfigSnapshot } from "../config/io.js";
import {
  loadSessionEntry,
  patchSessionEntryCore,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import {
  emitAgentEvent,
  emitAgentEventForOwner,
  getAgentEventLifecycleGeneration,
  onAgentEvent,
} from "../infra/agent-events.js";
import {
  claimAgentRunContext,
  getAgentRunContextOwnerStatus,
  releaseAgentRunContext,
} from "../infra/agent-run-registry.js";
import type { SubsystemLogger } from "../logging/subsystem.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { waitForChatAbortControllerRemoval } from "./chat-abort-lifecycle-internal.js";
import { registerChatAbortController } from "./chat-abort.js";
import {
  createChatRunState,
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
} from "./server-chat-state.js";
import { chatHistoryHandlers } from "./server-methods/chat-history-handler.js";
import { resolveVisibleActiveSessionRunState } from "./server-methods/session-active-runs.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { startGatewayEventSubscriptions } from "./server-runtime-subscriptions.js";
import * as lifecycleState from "./session-lifecycle-state.js";

const routing = vi.hoisted(() => ({ loadSessionEntry: vi.fn() }));
vi.mock("./session-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-utils.js")>()),
  loadSessionEntry: routing.loadSessionEntry,
}));

const persistenceTestWarnings = vi.fn();
const silentLog: SubsystemLogger = {
  subsystem: "gateway-lifecycle-persistence-test",
  isEnabled: () => false,
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: persistenceTestWarnings,
  error: vi.fn(),
  fatal: vi.fn(),
  raw: vi.fn(),
  child: () => silentLog,
};

it("persists current-run timing after pre-start failure and clears it on the next run", async () => {
  const tempDirs = createTempDirTracker();
  const target = {
    storePath: path.join(tempDirs.make("openclaw-lifecycle-timing-"), "sessions.json"),
    sessionKey: "agent:main:timing",
  };
  let now = 1_000_000;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  routing.loadSessionEntry.mockImplementation(() => ({
    ...target,
    canonicalKey: target.sessionKey,
    entry: loadSessionEntry(target),
  }));
  let persistence = Promise.resolve();
  const unsubscribe = onAgentEvent((event) => {
    if (event.sessionKey === target.sessionKey && event.stream === "lifecycle") {
      persistence = persistence.then(() =>
        lifecycleState.persistGatewaySessionLifecycleEvent({
          sessionKey: target.sessionKey,
          event,
        }),
      );
    }
  });
  const createBackstop = (runId: string) =>
    createAgentLifecycleTerminalBackstop({
      runId,
      sessionKey: target.sessionKey,
      getLifecycleGeneration: getAgentEventLifecycleGeneration,
      resolveTerminationFields: () => ({}),
    });
  const start = (runId: string) => {
    const backstop = createBackstop(runId);
    const data = { phase: "start", startedAt: now };
    emitAgentEvent({ runId, sessionKey: target.sessionKey, stream: "lifecycle", data });
    backstop.note({ stream: "lifecycle", data });
    return backstop;
  };
  try {
    await replaceSessionEntry(target, { sessionId: "timing-session", updatedAt: now });
    const previous = start("timing-persisted-previous");
    now += 11_192;
    previous.emit("end", { meta: {} });
    await persistence;
    expect(loadSessionEntry(target)).toMatchObject({
      status: "done",
      startedAt: 1_000_000,
      runtimeMs: 11_192,
    });

    now = 3_475_979;
    const failed = createBackstop("timing-persisted-failed");
    now += 4_700;
    failed.emit("error", new Error("preparation failed"));
    await persistence;
    expect.soft(loadSessionEntry(target)).toMatchObject({
      status: "failed",
      startedAt: 3_475_979,
      endedAt: 3_480_679,
      runtimeMs: 4_700,
      lastRunError: "preparation failed",
      lastRunId: "timing-persisted-failed",
    });

    now = 3_600_000;
    const recovered = start("timing-persisted-recovered");
    await persistence;
    const running = loadSessionEntry(target);
    expect(running).toMatchObject({ status: "running", startedAt: 3_600_000 });
    expect(running?.runtimeMs).toBeUndefined();
    expect(running?.endedAt).toBeUndefined();
    expect(running?.lastRunError).toBeUndefined();
    now += 11_192;
    recovered.emit("end", { meta: {} });
    await persistence;
    closeOpenClawAgentDatabasesForTest();
    expect(loadSessionEntry(target)).toMatchObject({
      status: "done",
      startedAt: 3_600_000,
      endedAt: 3_611_192,
      runtimeMs: 11_192,
      lastRunId: "timing-persisted-recovered",
    });
  } finally {
    unsubscribe();
    await persistence;
    clock.mockRestore();
    routing.loadSessionEntry.mockReset();
    closeOpenClawAgentDatabasesForTest();
    tempDirs.cleanup();
  }
});

it.each(["success", "failed-write"])(
  "settles native child cancellation through %s without retry grace",
  async (outcome) => {
    const state = await createOpenClawTestState({ label: "native-cancel-lifecycle" });
    const cfg = { agents: { entries: { main: {} } } };
    setRuntimeConfigSnapshot(cfg, cfg);
    const target = {
      storePath: path.join(state.sessionsDir(), "sessions.json"),
      sessionKey: "agent:main:subagent:native-cancel",
    };
    const sessionId = "native-cancel-session";
    const runId = "native-cancel-run";
    const chatRunState = createChatRunState();
    const broadcast = vi.fn();
    const broadcastToConnIds = vi.fn();
    const context = {
      chatRunState,
      chatAbortControllers: new Map(),
      getRuntimeConfig: () => cfg,
      logGateway: silentLog,
    } as unknown as GatewayRequestContext;
    const registration = registerChatAbortController({
      chatAbortControllers: context.chatAbortControllers,
      runId,
      sessionId,
      sessionKey: target.sessionKey,
      agentId: "main",
      timeoutMs: 60_000,
      kind: "agent",
    });
    registration.markExecutionStarted();
    const entry = registration.entry;
    if (!entry) {
      throw new Error("expected registered child");
    }
    const startPersisted = createDeferred();
    const terminalWrite = createDeferred();
    let persistenceSpy:
      | MockInstance<typeof lifecycleState.persistGatewaySessionLifecycleEvent>
      | undefined;
    const restartRecoveryCandidates = new Map();
    const writerStarted = createDeferred();
    const releaseWriter = createDeferred();
    let heldWriter: Promise<unknown> | undefined;
    let subscriptions: ReturnType<typeof startGatewayEventSubscriptions> | undefined;
    const actual = await vi.importActual<typeof import("./session-utils.js")>("./session-utils.js");
    routing.loadSessionEntry.mockImplementation(actual.loadSessionEntry);
    const readHistory = async () => {
      const respond = vi.fn();
      await chatHistoryHandlers["chat.history"]!({
        req: { type: "req", id: "native-cancel-history", method: "chat.history" },
        params: { sessionKey: target.sessionKey, agentId: "main" },
        client: null,
        isWebchatConnect: () => false,
        respond,
        context,
      });
      expect(respond.mock.calls[0]?.[0]).toBe(true);
      return respond.mock.calls[0]?.[1];
    };
    try {
      await replaceSessionEntry(target, {
        sessionId,
        spawnedBy: "agent:main:main",
        updatedAt: 1_000,
      });
      const sessionEventSubscribers = createSessionEventSubscriberRegistry();
      sessionEventSubscribers.subscribe("session-observer");
      subscriptions = startGatewayEventSubscriptions({
        log: silentLog,
        broadcast,
        broadcastToConnIds,
        nodeSendToSession: vi.fn(),
        agentRunSeq: new Map(),
        chatRunState,
        toolEventRecipients: chatRunState.toolEventRecipients,
        sessionEventSubscribers,
        sessionMessageSubscribers: createSessionMessageSubscriberRegistry(),
        chatAbortControllers: context.chatAbortControllers,
        restartRecoveryCandidates,
        terminalSessions: { closeTaskSessions: vi.fn() },
      });
      const persistLifecycleEvent = lifecycleState.persistGatewaySessionLifecycleEvent;
      persistenceSpy = vi
        .spyOn(lifecycleState, "persistGatewaySessionLifecycleEvent")
        .mockImplementation((params) => {
          const persistence = persistLifecycleEvent(params);
          if (params.event.runId === runId && params.event.data?.phase === "start") {
            startPersisted.resolve(persistence);
          }
          return persistence;
        });
      emitAgentEvent({
        runId,
        sessionId,
        sessionKey: target.sessionKey,
        stream: "lifecycle",
        data: { phase: "start", startedAt: 1_000 },
      });
      // The first start crosses lazy handler loading; await its real commit,
      // not a polling deadline that also measures cold module initialization.
      await startPersisted.promise;
      expect(loadSessionEntry(target)?.status).toBe("running");
      expect(await readHistory()).toMatchObject({
        sessionInfo: { status: "running", hasActiveRun: true, activeRunIds: [runId] },
      });
      heldWriter = patchSessionEntryCore(target, async () => {
        writerStarted.resolve();
        await releaseWriter.promise;
        return null;
      });
      await writerStarted.promise;
      if (outcome === "failed-write") {
        persistenceSpy.mockReturnValueOnce(terminalWrite.promise);
      }

      emitAgentEvent({
        runId,
        sessionId,
        sessionKey: target.sessionKey,
        stream: "lifecycle",
        data: { phase: "error", aborted: true, stopReason: "aborted", endedAt: 2_000 },
      });
      registration.cleanup();
      expect(chatRunState.runs.get(runId)?.abortMarker).toBeUndefined();
      expect(context.chatAbortControllers.get(runId)).toBe(registration.entry);
      expect(registration.entry?.projectSessionTerminalPersistence).toBeInstanceOf(Promise);
      expect(
        resolveVisibleActiveSessionRunState({
          context,
          requestedKey: target.sessionKey,
          canonicalKey: target.sessionKey,
          sessionId,
          agentId: "main",
        }),
      ).toEqual({ active: false, runIds: [] });
      expect(await readHistory()).toMatchObject({
        sessionInfo: { status: "running", hasActiveRun: true },
      });

      if (outcome === "failed-write") {
        const removed = waitForChatAbortControllerRemoval({
          entries: context.chatAbortControllers,
          targets: [{ runId, entry }],
          timeoutMs: 1_000,
        });
        terminalWrite.reject(new Error("terminal write failed"));
        expect(await removed).toBe(false);
        expect(restartRecoveryCandidates.get(runId)).toMatchObject({
          sessionId,
          observedAt: 2_000,
        });
        expect(entry.projectSessionTerminalPersisted).toBe(false);
        expect(loadSessionEntry(target)?.status).toBe("running");
        return;
      }
      releaseWriter.resolve();
      await heldWriter;
      await vi.waitFor(() => expect(context.chatAbortControllers.has(runId)).toBe(false));
      await vi.waitFor(() =>
        expect(broadcast).toHaveBeenCalledWith(
          "chat",
          expect.objectContaining({ runId, state: "aborted", stopReason: "aborted" }),
          expect.anything(),
        ),
      );
      expect(await readHistory()).toMatchObject({
        sessionInfo: {
          status: "killed",
          hasActiveRun: false,
          activeRunIds: [],
          startedAt: 1_000,
          endedAt: 2_000,
          runtimeMs: 1_000,
          abortedLastRun: true,
        },
      });
      expect(broadcastToConnIds).toHaveBeenCalledWith(
        "sessions.changed",
        expect.objectContaining({ runId, status: "killed", hasActiveRun: false, runtimeMs: 1_000 }),
        new Set(["session-observer"]),
        { dropIfSlow: true },
      );
      closeOpenClawAgentDatabasesForTest();
      expect(loadSessionEntry({ ...target, readConsistency: "latest" })).toMatchObject({
        status: "killed",
        lastRunId: runId,
        endedAt: 2_000,
        runtimeMs: 1_000,
      });
    } finally {
      terminalWrite.resolve();
      releaseWriter.resolve();
      await heldWriter;
      await subscriptions?.agentUnsub();
      subscriptions?.heartbeatUnsub();
      subscriptions?.transcriptUnsub();
      subscriptions?.lifecycleUnsub();
      await subscriptions?.taskUnsub();
      registration.cleanup();
      persistenceSpy?.mockRestore();
      routing.loadSessionEntry.mockReset();
      await state.cleanup();
    }
  },
);

it.each([
  { label: "end", phase: "end", data: {}, status: "done" },
  {
    label: "cancellation",
    phase: "error",
    data: { aborted: true, stopReason: "aborted" },
    status: "killed",
  },
  {
    label: "settled failure",
    phase: "error",
    data: { executionSettled: true, error: "Preparation failed" },
    status: "failed",
  },
])(
  "keeps an owner claim active until its queued $label write commits",
  async ({ phase, data, status }) => {
    const tempDirs = createTempDirTracker();
    const target = {
      storePath: path.join(tempDirs.make("openclaw-owner-terminal-"), "sessions.json"),
      sessionKey: "agent:main:worker-terminal",
    };
    const runId = "worker-terminal-run";
    const sessionId = "worker-terminal-session";
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const writerStarted = createDeferred();
    const releaseWriter = createDeferred();
    let claimId: string | undefined;
    let subscriptions: ReturnType<typeof startGatewayEventSubscriptions> | undefined;
    let heldWriter: Promise<unknown> | undefined;
    persistenceTestWarnings.mockReset();
    routing.loadSessionEntry.mockImplementation(() => ({
      ...target,
      canonicalKey: target.sessionKey,
      entry: loadSessionEntry(target),
    }));
    try {
      await replaceSessionEntry(target, {
        lifecycleRunId: runId,
        sessionId,
        startedAt: 1_000,
        status: "running",
        updatedAt: 1_000,
      });
      heldWriter = patchSessionEntryCore(target, async () => {
        writerStarted.resolve();
        await releaseWriter.promise;
        return null;
      });
      await writerStarted.promise;
      claimId = claimAgentRunContext(
        runId,
        { lifecycleGeneration, sessionId, sessionKey: target.sessionKey },
        { exclusive: true, ownsContext: true, trackOwner: true },
      );
      if (!claimId) {
        throw new Error("expected worker terminal claim");
      }
      const terminalClaimId = claimId;
      const chatRunState = createChatRunState();
      const markFinal = vi.spyOn(chatRunState.toolEventRecipients, "markFinal");
      const agentRunSeq = new Map<string, number>();
      subscriptions = startGatewayEventSubscriptions({
        log: silentLog,
        broadcast: vi.fn(),
        broadcastToConnIds: vi.fn(),
        nodeSendToSession: vi.fn(),
        agentRunSeq,
        chatRunState,
        toolEventRecipients: chatRunState.toolEventRecipients,
        sessionEventSubscribers: createSessionEventSubscriberRegistry(),
        sessionMessageSubscribers: createSessionMessageSubscriberRegistry(),
        chatAbortControllers: new Map(),
        restartRecoveryCandidates: new Map(),
        terminalSessions: { closeTaskSessions: vi.fn() },
      });

      emitAgentEventForOwner(
        {
          runId,
          sessionId,
          sessionKey: target.sessionKey,
          stream: "lifecycle",
          data: { phase, ...data, startedAt: 1_000, endedAt: 2_000 },
        },
        claimId,
      );
      await vi.waitFor(
        () =>
          expect(
            markFinal.mock.calls.length + persistenceTestWarnings.mock.calls.length,
          ).toBeGreaterThan(0),
        { timeout: 10_000 },
      );
      expect(persistenceTestWarnings).not.toHaveBeenCalled();
      expect(markFinal).toHaveBeenCalledWith(runId);

      expect(getAgentRunContextOwnerStatus(runId, terminalClaimId, lifecycleGeneration)).toBe(
        "active",
      );
      releaseWriter.resolve();
      await heldWriter;
      await vi.waitFor(() => expect(loadSessionEntry(target)?.status).toBe(status));
      await vi.waitFor(() =>
        expect(getAgentRunContextOwnerStatus(runId, terminalClaimId, lifecycleGeneration)).toBe(
          "clear-requested",
        ),
      );
    } finally {
      releaseWriter.resolve();
      await heldWriter;
      await subscriptions?.agentUnsub();
      subscriptions?.heartbeatUnsub();
      subscriptions?.transcriptUnsub();
      subscriptions?.lifecycleUnsub();
      await subscriptions?.taskUnsub();
      releaseAgentRunContext(runId, claimId);
      routing.loadSessionEntry.mockReset();
      closeOpenClawAgentDatabasesForTest();
      tempDirs.cleanup();
    }
  },
);
