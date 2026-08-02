import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRecoveryRuntime } from "../gateway/server-instance-runtime.types.js";
import {
  resetOrphanRecoveryCoordinationForTest,
  scheduleOrphanRecovery,
} from "./subagent-orphan-recovery.js";
import * as subagentRegistrySteerRuntime from "./subagent-registry-steer-runtime.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { createSubagentRunRecord } from "./subagent-test-fixtures.test-helpers.js";

const sessionMocks = vi.hoisted(() => {
  type MockSessionEntry = Record<string, unknown>;
  type MockSessionStore = Record<string, MockSessionEntry>;
  const loadSessionStore = vi.fn((): MockSessionStore => ({}));
  const patchSessionEntry = vi.fn(
    async (
      scope: { sessionKey: string },
      update: (
        entry: MockSessionEntry,
      ) => MockSessionEntry | Partial<MockSessionEntry> | null | Promise<MockSessionEntry | null>,
    ) => {
      const store = loadSessionStore();
      const current = store[scope.sessionKey];
      if (!current) {
        return null;
      }
      const next = await update({ ...current });
      if (!next) {
        return current;
      }
      store[scope.sessionKey] = next;
      return next;
    },
  );
  return { loadSessionStore, patchSessionEntry };
});

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: vi.fn(() => ({ session: { store: undefined } })),
}));

vi.mock("../config/sessions.js", () => ({
  resolveAgentIdFromSessionKey: vi.fn(() => "main"),
  resolveStorePath: vi.fn(() => "/tmp/test-sessions.json"),
}));

vi.mock("../config/sessions/session-accessor.js", () => ({
  loadSessionEntry: vi.fn(
    (scope: { sessionKey: string }) => sessionMocks.loadSessionStore()[scope.sessionKey],
  ),
  patchSessionEntry: sessionMocks.patchSessionEntry,
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ info: vi.fn(), warn: vi.fn() }),
}));

vi.mock("./subagent-registry-steer-runtime.js", () => ({
  finalizeInterruptedSubagentRun: vi.fn(async () => 1),
  replaceSubagentRunAfterSteer: vi.fn(() => true),
  reserveSwarmCollectorLaunch: vi.fn(() => true),
}));

const childSessionKey = "agent:main:subagent:recovery-coordination";
const dispatchAgent = vi.fn(async () => ({ runId: "recovery-run" }));
const readSessionMessages = vi.fn(async () => [] as unknown[]);
const gatewayRuntime: GatewayRecoveryRuntime = {
  dispatchAgent: dispatchAgent as GatewayRecoveryRuntime["dispatchAgent"],
  waitForAgent: vi.fn(),
  sendRecoveryNotice: vi.fn(),
};

function createRun(): SubagentRunRecord {
  return createSubagentRunRecord({
    runId: "interrupted-run",
    childSessionKey,
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "continue the interrupted task",
    cleanup: "keep",
    createdAt: Date.now() - 60_000,
    startedAt: Date.now() - 55_000,
  });
}

function createActiveRuns(): Map<string, SubagentRunRecord> {
  const run = createRun();
  return new Map([[run.runId, run]]);
}

function mockAbortedSession() {
  const store = {
    [childSessionKey]: {
      sessionId: "session-1",
      updatedAt: Date.now(),
      abortedLastRun: true,
    },
  };
  sessionMocks.loadSessionStore.mockReturnValue(store);
  return store;
}

function schedule(
  getActiveRuns: () => Map<string, SubagentRunRecord>,
  options: {
    delayMs?: number;
    getGatewayRuntime?: () => GatewayRecoveryRuntime | undefined;
    maxRetries?: number;
  } = {},
) {
  scheduleOrphanRecovery({
    getGatewayRuntime: options.getGatewayRuntime ?? (() => gatewayRuntime),
    getActiveRuns,
    readSessionMessages,
    delayMs: options.delayMs ?? 1,
    maxRetries: options.maxRetries ?? 0,
  });
}

describe("subagent orphan recovery coordination", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    resetOrphanRecoveryCoordinationForTest();
    dispatchAgent.mockResolvedValue({ runId: "recovery-run" });
    readSessionMessages.mockResolvedValue([]);
    vi.mocked(subagentRegistrySteerRuntime.finalizeInterruptedSubagentRun).mockResolvedValue(1);
  });

  afterEach(() => {
    resetOrphanRecoveryCoordinationForTest();
    vi.useRealTimers();
  });

  it("coalesces duplicate schedules before the recovery scan starts", async () => {
    mockAbortedSession();
    const activeRuns = createActiveRuns();
    const getActiveRuns = vi.fn(() => activeRuns);

    schedule(getActiveRuns);
    schedule(getActiveRuns);
    await vi.advanceTimersByTimeAsync(1);

    expect(getActiveRuns).toHaveBeenCalledOnce();
    expect(dispatchAgent).toHaveBeenCalledOnce();
    expect(sessionMocks.patchSessionEntry).toHaveBeenCalledOnce();
  });

  it("queues one follow-up scan when recovery is requested during an active scan", async () => {
    mockAbortedSession();
    const activeRuns = createActiveRuns();
    const getActiveRuns = vi.fn(() => activeRuns);
    let releaseDispatch: () => void = () => {};
    let markDispatchStarted: () => void = () => {};
    const dispatchStarted = new Promise<void>((resolve) => {
      markDispatchStarted = resolve;
    });
    const dispatchRelease = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    dispatchAgent.mockImplementationOnce(async () => {
      markDispatchStarted();
      await dispatchRelease;
      return { runId: "recovery-run" };
    });

    schedule(getActiveRuns);
    await vi.advanceTimersByTimeAsync(1);
    await dispatchStarted;

    schedule(getActiveRuns);
    releaseDispatch();
    await vi.advanceTimersByTimeAsync(0);
    expect(getActiveRuns).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1);

    expect(getActiveRuns).toHaveBeenCalledTimes(2);
    expect(dispatchAgent).toHaveBeenCalledOnce();
  });

  it("queues one follow-up scan when recovery is requested during retry backoff", async () => {
    mockAbortedSession();
    const activeRuns = createActiveRuns();
    const getActiveRuns = vi.fn(() => activeRuns);
    dispatchAgent
      .mockRejectedValueOnce(new Error("gateway unavailable"))
      .mockResolvedValueOnce({ runId: "recovery-run" });

    schedule(getActiveRuns, { maxRetries: 1 });
    await vi.advanceTimersByTimeAsync(1);

    schedule(getActiveRuns);
    await vi.advanceTimersByTimeAsync(2);

    expect(getActiveRuns).toHaveBeenCalledTimes(2);
    expect(dispatchAgent).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1);

    expect(getActiveRuns).toHaveBeenCalledTimes(3);
    expect(dispatchAgent).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["missing runtime", () => undefined],
    [
      "thrown runtime lookup",
      () => {
        throw new Error("runtime unavailable");
      },
    ],
  ])("releases coordination after terminal %s", async (_label, getGatewayRuntime) => {
    mockAbortedSession();
    const activeRuns = createActiveRuns();
    const getActiveRuns = vi.fn(() => activeRuns);

    schedule(getActiveRuns, { getGatewayRuntime });
    await vi.advanceTimersByTimeAsync(1);

    schedule(getActiveRuns);
    await vi.advanceTimersByTimeAsync(1);

    expect(getActiveRuns).toHaveBeenCalledOnce();
    expect(dispatchAgent).toHaveBeenCalledOnce();
  });

  it("releases coordination after terminal finalization is exhausted", async () => {
    mockAbortedSession();
    const activeRuns = createActiveRuns();
    const getActiveRuns = vi.fn(() => activeRuns);
    dispatchAgent.mockRejectedValueOnce(new Error("gateway unavailable"));
    vi.mocked(subagentRegistrySteerRuntime.finalizeInterruptedSubagentRun).mockResolvedValue(0);

    schedule(getActiveRuns);
    await vi.advanceTimersByTimeAsync(4);

    expect(subagentRegistrySteerRuntime.finalizeInterruptedSubagentRun).toHaveBeenCalledTimes(3);

    schedule(getActiveRuns);
    await vi.advanceTimersByTimeAsync(1);

    expect(getActiveRuns).toHaveBeenCalledTimes(2);
    expect(dispatchAgent).toHaveBeenCalledTimes(2);
  });
});
