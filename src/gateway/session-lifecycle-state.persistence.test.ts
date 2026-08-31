import path from "node:path";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createAgentLifecycleTerminalBackstop } from "../auto-reply/reply/agent-lifecycle-terminal.js";
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
import {
  createChatRunState,
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
} from "./server-chat-state.js";
import { startGatewayEventSubscriptions } from "./server-runtime-subscriptions.js";
import { persistGatewaySessionLifecycleEvent } from "./session-lifecycle-state.js";

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
        persistGatewaySessionLifecycleEvent({ sessionKey: target.sessionKey, event }),
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

it("keeps an owner claim active until its queued terminal write commits", async () => {
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
        data: { phase: "end", startedAt: 1_000, endedAt: 2_000 },
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
    await vi.waitFor(() => expect(loadSessionEntry(target)?.status).toBe("done"));
    await vi.waitFor(() =>
      expect(getAgentRunContextOwnerStatus(runId, terminalClaimId, lifecycleGeneration)).toBe(
        "clear-requested",
      ),
    );
  } finally {
    releaseWriter.resolve();
    await heldWriter;
    await subscriptions?.agentUnsub();
    releaseAgentRunContext(runId, claimId);
    routing.loadSessionEntry.mockReset();
    closeOpenClawAgentDatabasesForTest();
    tempDirs.cleanup();
  }
});
