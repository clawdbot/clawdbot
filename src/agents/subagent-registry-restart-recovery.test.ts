import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRecoveryRuntime } from "../gateway/server-instance-runtime.types.js";
import { recoverInterruptedSubagentRow } from "./subagent-registry-restart-recovery.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import {
  createSubagentRunRecord,
  type SubagentRunRecordOverrides,
} from "./subagent-test-fixtures.test-helpers.js";

const mocks = vi.hoisted(() => ({
  entries: {} as Record<string, Record<string, unknown>>,
  loadSessionEntry: vi.fn(),
  patchSessionEntry: vi.fn(),
  readSessionMessages: vi.fn(async () => [] as unknown[]),
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => ({ session: { store: undefined } }),
}));
vi.mock("../config/sessions.js", () => ({
  resolveAgentIdFromSessionKey: () => "main",
  resolveStorePath: () => "/tmp/subagent-recovery.sqlite",
}));
vi.mock("../config/sessions/session-accessor.js", () => ({
  loadSessionEntry: mocks.loadSessionEntry,
  patchSessionEntry: mocks.patchSessionEntry,
}));
vi.mock("../gateway/session-transcript-readers.js", () => ({
  extractMessageRole: (message: { role?: string }) => message?.role,
  extractMessageText: (message: { content?: string }) => message?.content ?? null,
  readSessionMessagesAsync: mocks.readSessionMessages,
}));

const childSessionKey = "agent:main:subagent:restart-child";
const dispatchAgent = vi.fn(async () => ({ runId: "replacement-run" }));
const gatewayRuntime: GatewayRecoveryRuntime = {
  dispatchAgent: dispatchAgent as GatewayRecoveryRuntime["dispatchAgent"],
  waitForAgent: vi.fn(),
  sendRecoveryNotice: vi.fn(),
};
const replaceRun = vi.fn(() => true);
const reserveCollectorLaunch = vi.fn(() => true);
const warn = vi.fn();

function run(overrides: Partial<SubagentRunRecordOverrides> = {}): SubagentRunRecord {
  return createSubagentRunRecord({
    runId: "original-run",
    childSessionKey,
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "finish the restart-safe task",
    cleanup: "keep",
    createdAt: Date.now() - 60_000,
    startedAt: Date.now() - 55_000,
    ...overrides,
  });
}

function recover(
  entry: SubagentRunRecord,
  overrides: Partial<Parameters<typeof recoverInterruptedSubagentRow>[0]> = {},
) {
  return recoverInterruptedSubagentRow({
    runId: entry.runId,
    entry,
    now: Date.now(),
    gatewayRuntime,
    isCurrent: () => true,
    replaceRun,
    reserveCollectorLaunch,
    warn,
    ...overrides,
  });
}

describe("subagent registry restart recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.entries = {
      [childSessionKey]: {
        sessionId: "session-id",
        updatedAt: Date.now(),
        abortedLastRun: true,
      },
    };
    mocks.loadSessionEntry.mockImplementation(
      ({ sessionKey }: { sessionKey: string }) => mocks.entries[sessionKey],
    );
    mocks.patchSessionEntry.mockImplementation(
      async (
        { sessionKey }: { sessionKey: string },
        update: (entry: Record<string, unknown>) => Record<string, unknown>,
      ) => {
        const current = mocks.entries[sessionKey];
        if (!current) {
          return null;
        }
        const next = update({ ...current });
        mocks.entries[sessionKey] = next;
        return next;
      },
    );
    dispatchAgent.mockResolvedValue({ runId: "replacement-run" });
    replaceRun.mockReturnValue(true);
    reserveCollectorLaunch.mockReturnValue(true);
    mocks.readSessionMessages.mockResolvedValue([]);
  });

  it("resumes a collector with transcript context and its output contract", async () => {
    mocks.readSessionMessages.mockResolvedValue([
      { role: "user", content: "latest user direction" },
      { role: "assistant", content: "I updated openclaw.json" },
    ]);
    const entry = run({ collect: true, outputSchema: { type: "object" } });

    await expect(recover(entry)).resolves.toEqual({
      status: "accepted",
      sessionMarker: undefined,
    });

    expect(dispatchAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: childSessionKey,
        lane: "subagent",
        deliver: false,
        swarmCollector: true,
        swarmOutputSchema: { type: "object" },
        sessionEffects: "internal",
        suppressPromptPersistence: true,
        message: expect.stringMatching(/latest user direction[\s\S]*already applied/),
      }),
      10_000,
    );
    expect(reserveCollectorLaunch).toHaveBeenCalledWith("original-run", expect.any(String));
    expect(replaceRun).toHaveBeenCalledWith(
      expect.objectContaining({
        previousRunId: "original-run",
        nextRunId: "replacement-run",
        expected: entry,
        task: "finish the restart-safe task",
      }),
    );
    expect(mocks.entries[childSessionKey]).toMatchObject({
      abortedLastRun: false,
      subagentRecovery: {
        automaticAttempts: 1,
        lastRunId: "original-run",
      },
    });
  });

  it("ignores non-aborted, yielded, and already-terminal rows", async () => {
    mocks.entries[childSessionKey]!.abortedLastRun = false;
    await expect(recover(run())).resolves.toEqual({ status: "ignored" });

    mocks.entries[childSessionKey]!.abortedLastRun = true;
    await expect(recover(run({ pauseReason: "sessions_yield" }))).resolves.toEqual({
      status: "ignored",
    });
    await expect(
      recover(
        run({
          execution: {
            status: "terminal",
            startedAt: Date.now() - 2_000,
            endedAt: Date.now(),
            outcome: { status: "ok" },
          },
        }),
      ),
    ).resolves.toEqual({ status: "ignored" });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it("returns stale and durable terminal owners to the sweeper finalizer", async () => {
    const stale = run({
      createdAt: Date.now() - 3 * 60 * 60_000,
      startedAt: Date.now() - 3 * 60 * 60_000,
    });
    await expect(recover(stale)).resolves.toMatchObject({
      status: "terminal",
      error: expect.stringContaining("stale aborted subagent run"),
    });

    const endedAt = Date.now();
    const replay = run({
      terminalOwner: "interrupted-recovery",
      endedReason: "subagent-error",
      execution: {
        status: "terminal",
        endedAt,
        outcome: { status: "error", error: "saved exact failure" },
      },
    });
    mocks.loadSessionEntry.mockClear();
    await expect(recover(replay)).resolves.toEqual({
      status: "terminal",
      error: "saved exact failure",
      endedAt,
    });
    expect(mocks.loadSessionEntry).not.toHaveBeenCalled();
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it("reclassifies shipped restart-timeout rows before dispatch", async () => {
    const entry = run({
      endedReason: "subagent-error",
      execution: {
        status: "terminal",
        endedAt: Date.now() - 1_000,
        outcome: { status: "timeout" },
      },
    });

    await expect(recover(entry)).resolves.toMatchObject({ status: "accepted" });
    expect(entry.execution).toMatchObject({
      status: "interrupted",
      interruptionReason: "gateway-restart",
      endedAt: undefined,
      outcome: undefined,
    });
    expect(entry.endedReason).toBeUndefined();
  });

  it("defers without consuming the dispatch path until a runtime exists", async () => {
    const entry = run();
    await expect(recover(entry, { gatewayRuntime: undefined })).resolves.toEqual({
      status: "deferred",
    });
    expect(mocks.readSessionMessages).not.toHaveBeenCalled();
    expect(mocks.entries[childSessionKey]!.abortedLastRun).toBe(true);
  });

  it("preserves the abort marker when dispatch fails", async () => {
    dispatchAgent.mockRejectedValueOnce(new Error("runtime not ready"));
    await expect(recover(run())).resolves.toEqual({
      status: "retry",
      error: "runtime not ready",
    });
    expect(mocks.patchSessionEntry).not.toHaveBeenCalled();
    expect(mocks.entries[childSessionKey]!.abortedLastRun).toBe(true);
  });

  it("treats accepted dispatch as authoritative across remap and patch failures", async () => {
    replaceRun.mockReturnValue(false);
    mocks.patchSessionEntry.mockRejectedValueOnce(new Error("store unavailable"));
    const entry = run();
    const marker = `session-id:${String(mocks.entries[childSessionKey]!.updatedAt)}`;

    await expect(recover(entry)).resolves.toEqual({ status: "accepted", sessionMarker: marker });
    await expect(recover(entry, { acceptedSessionMarker: marker })).resolves.toEqual({
      status: "handled",
    });
    expect(dispatchAgent).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("could not remap"),
      expect.any(Object),
    );
  });

  it("tombstones a rapid third accepted recovery", async () => {
    mocks.entries[childSessionKey]!.subagentRecovery = {
      automaticAttempts: 2,
      lastAttemptAt: Date.now(),
      lastRunId: "prior-run",
    };

    await expect(recover(run())).resolves.toEqual({ status: "handled" });
    expect(dispatchAgent).not.toHaveBeenCalled();
    expect(mocks.entries[childSessionKey]).toMatchObject({
      abortedLastRun: false,
      subagentRecovery: {
        automaticAttempts: 2,
        wedgedAt: expect.any(Number),
      },
    });
  });
});
