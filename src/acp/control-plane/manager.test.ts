import { setTimeout as scheduleNativeTimeout } from "node:timers";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { AcpSessionRuntimeOptions, SessionAcpMeta } from "../../config/sessions/types.js";
import { resetHeartbeatWakeStateForTests } from "../../infra/heartbeat-wake.js";
import { withTempDir } from "../../test-helpers/temp-dir.js";
import type { AcpRuntime, AcpRuntimeCapabilities } from "../runtime/types.js";

const hoisted = vi.hoisted(() => {
  const listAcpSessionEntriesMock = vi.fn();
  const readAcpSessionEntryMock = vi.fn();
  const upsertAcpSessionMetaMock = vi.fn();
  const getAcpRuntimeBackendMock = vi.fn();
  const requireAcpRuntimeBackendMock = vi.fn();
  return {
    listAcpSessionEntriesMock,
    readAcpSessionEntryMock,
    upsertAcpSessionMetaMock,
    getAcpRuntimeBackendMock,
    requireAcpRuntimeBackendMock,
  };
});

vi.mock("../runtime/session-meta.js", () => ({
  listAcpSessionEntries: (params: unknown) => hoisted.listAcpSessionEntriesMock(params),
  readAcpSessionEntry: (params: unknown) => hoisted.readAcpSessionEntryMock(params),
  upsertAcpSessionMeta: (params: unknown) => hoisted.upsertAcpSessionMetaMock(params),
}));

vi.mock("../runtime/registry.js", () => ({
  getAcpRuntimeBackend: (backendId?: string) => hoisted.getAcpRuntimeBackendMock(backendId),
  requireAcpRuntimeBackend: (backendId?: string) => hoisted.requireAcpRuntimeBackendMock(backendId),
}));

const {
  AcpSessionManager,
  __testing: { resetAcpSessionManagerForTests },
} = await import("./manager.js");
const { AcpRuntimeError } = await import("../runtime/errors.js");
const { findTaskByRunId, resetTaskRegistryForTests } = await import("../../tasks/task-registry.js");
const { resetTaskFlowRegistryForTests } = await import("../../tasks/task-flow-registry.js");
const { configureTaskFlowRegistryRuntime } =
  await import("../../tasks/task-flow-registry.store.js");
const { installInMemoryTaskRegistryRuntime } =
  await import("../../test-utils/task-registry-runtime.js");

const baseCfg = {
  acp: {
    enabled: true,
    backend: "acpx",
    dispatch: { enabled: true },
  },
} as const;
const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;

async function withAcpManagerTaskStateDir(run: (root: string) => Promise<void>): Promise<void> {
  await withTempDir({ prefix: "openclaw-acp-manager-task-" }, async (root) => {
    process.env.OPENCLAW_STATE_DIR = root;
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    installInMemoryTaskRegistryRuntime();
    configureTaskFlowRegistryRuntime({
      store: {
        loadSnapshot: () => ({
          flows: new Map(),
        }),
        saveSnapshot: () => {},
        upsertFlow: () => {},
        deleteFlow: () => {},
        close: () => {},
      },
    });
    try {
      await run(root);
    } finally {
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
    }
  });
}

async function flushMicrotasks(rounds = 3): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await Promise.resolve();
  }
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  if (!resolve) {
    throw new Error("Expected deferred resolver to be initialized");
  }
  return { promise, resolve };
}

function expectRecordFields(record: unknown, expected: Record<string, unknown>) {
  expect(record).toBeDefined();
  const actual = record as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected)) {
    expect(actual[key]).toEqual(value);
  }
  return actual;
}

async function expectRejectedRecord(promise: Promise<unknown>, expected: Record<string, unknown>) {
  await promise.then(
    () => {
      throw new Error("Expected promise to reject.");
    },
    (error) => {
      expectRecordFields(error, expected);
    },
  );
}

function mockCallArg(mock: ReturnType<typeof vi.fn>, callIndex = 0): Record<string, unknown> {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected mock call ${callIndex}`);
  }
  return call[0] as Record<string, unknown>;
}

function mockCallArgs(mock: ReturnType<typeof vi.fn>): Array<Record<string, unknown>> {
  return mock.mock.calls.map((call) => call[0] as Record<string, unknown>);
}

function findMockCallFields(mock: ReturnType<typeof vi.fn>, expected: Record<string, unknown>) {
  return mockCallArgs(mock).find((actual) =>
    Object.entries(expected).every(([key, value]) => Object.is(actual[key], value)),
  );
}

function expectMockCallFields(mock: ReturnType<typeof vi.fn>, expected: Record<string, unknown>) {
  expect(findMockCallFields(mock, expected)).toBeDefined();
}

function expectNoMockCallFields(mock: ReturnType<typeof vi.fn>, expected: Record<string, unknown>) {
  expect(findMockCallFields(mock, expected)).toBeUndefined();
}

function requireTaskByRunId(runId: string) {
  const task = findTaskByRunId(runId);
  if (!task) {
    throw new Error(`Expected task for run ${runId}`);
  }
  return task;
}

function createRuntime(): {
  runtime: AcpRuntime;
  ensureSession: ReturnType<typeof vi.fn>;
  runTurn: ReturnType<typeof vi.fn>;
  prepareFreshSession: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  getCapabilities: ReturnType<typeof vi.fn>;
  getStatus: ReturnType<typeof vi.fn>;
  setMode: ReturnType<typeof vi.fn>;
  setConfigOption: ReturnType<typeof vi.fn>;
} {
  const ensureSession = vi.fn(
    async (input: {
      sessionKey: string;
      agent: string;
      mode: "persistent" | "oneshot";
      model?: string;
      thinking?: string;
      cwd?: string;
      resumeSessionId?: string;
    }) => ({
      sessionKey: input.sessionKey,
      backend: "acpx",
      runtimeSessionName: `${input.sessionKey}:${input.mode}:runtime`,
    }),
  );
  const runTurn = vi.fn(async function* () {
    yield { type: "done" as const };
  });
  const prepareFreshSession = vi.fn(async () => {});
  const cancel = vi.fn(async () => {});
  const close = vi.fn(async () => {});
  const getCapabilities = vi.fn(
    async (): Promise<AcpRuntimeCapabilities> => ({
      controls: ["session/set_mode", "session/set_config_option", "session/status"],
    }),
  );
  const getStatus = vi.fn(async () => ({
    summary: "status=alive",
    details: { status: "alive" },
  }));
  const setMode = vi.fn(async () => {});
  const setConfigOption = vi.fn(async () => {});
  return {
    runtime: {
      ensureSession,
      runTurn,
      getCapabilities,
      getStatus,
      setMode,
      setConfigOption,
      prepareFreshSession,
      cancel,
      close,
    },
    ensureSession,
    runTurn,
    prepareFreshSession,
    cancel,
    close,
    getCapabilities,
    getStatus,
    setMode,
    setConfigOption,
  };
}

function readySessionMeta(overrides: Partial<SessionAcpMeta> = {}): SessionAcpMeta {
  return {
    backend: "acpx",
    agent: "codex",
    runtimeSessionName: "runtime-1",
    mode: "persistent" as const,
    state: "idle" as const,
    lastActivityAt: Date.now(),
    ...overrides,
  };
}

function extractStatesFromUpserts(): SessionAcpMeta["state"][] {
  const states: SessionAcpMeta["state"][] = [];
  for (const [firstArg] of hoisted.upsertAcpSessionMetaMock.mock.calls) {
    const payload = firstArg as {
      mutate: (
        current: SessionAcpMeta | undefined,
        entry: { acp?: SessionAcpMeta } | undefined,
      ) => SessionAcpMeta | null | undefined;
    };
    const current = readySessionMeta();
    const next = payload.mutate(current, { acp: current });
    if (next?.state) {
      states.push(next.state);
    }
  }
  return states;
}

function extractRuntimeOptionsFromUpserts(): Array<AcpSessionRuntimeOptions | undefined> {
  const options: Array<AcpSessionRuntimeOptions | undefined> = [];
  for (const [firstArg] of hoisted.upsertAcpSessionMetaMock.mock.calls) {
    const payload = firstArg as {
      mutate: (
        current: SessionAcpMeta | undefined,
        entry: { acp?: SessionAcpMeta } | undefined,
      ) => SessionAcpMeta | null | undefined;
    };
    const current = readySessionMeta();
    const next = payload.mutate(current, { acp: current });
    if (next) {
      options.push(next.runtimeOptions);
    }
  }
  return options;
}

describe("AcpSessionManager", () => {
  beforeEach(() => {
    resetAcpSessionManagerForTests();
    vi.useRealTimers();
    hoisted.listAcpSessionEntriesMock.mockReset().mockResolvedValue([]);
    hoisted.readAcpSessionEntryMock.mockReset();
    hoisted.upsertAcpSessionMetaMock.mockReset().mockResolvedValue(null);
    hoisted.requireAcpRuntimeBackendMock.mockReset();
    hoisted.getAcpRuntimeBackendMock.mockReset().mockImplementation((backendId?: string) => {
      try {
        return hoisted.requireAcpRuntimeBackendMock(backendId);
      } catch {
        return null;
      }
    });
  });

  afterEach(() => {
    if (ORIGINAL_STATE_DIR === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = ORIGINAL_STATE_DIR;
    }
    resetHeartbeatWakeStateForTests();
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
  });

  it("marks ACP-shaped sessions without metadata as stale", () => {
    hoisted.readAcpSessionEntryMock.mockReturnValue(null);
    const manager = new AcpSessionManager();

    const resolved = manager.resolveSession({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-1",
    });

    expect(resolved.kind).toBe("stale");
    if (resolved.kind !== "stale") {
      return;
    }
    expect(resolved.error.code).toBe("ACP_SESSION_INIT_FAILED");
    expect(resolved.error.message).toContain("ACP metadata is missing");
  });

  it("canonicalizes the main alias before ACP rehydrate after restart", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const sessionKey = (paramsUnknown as { sessionKey?: string }).sessionKey;
      if (sessionKey !== "agent:main:main") {
        return null;
      }
      return {
        sessionKey,
        storeSessionKey: sessionKey,
        acp: {
          ...readySessionMeta(),
          agent: "main",
          runtimeSessionName: sessionKey,
        },
      };
    });

    const manager = new AcpSessionManager();
    const cfg = {
      ...baseCfg,
      session: { mainKey: "main" },
      agents: { list: [{ id: "main", default: true }] },
    } as OpenClawConfig;

    await manager.runTurn({
      cfg,
      sessionKey: "main",
      text: "after restart",
      mode: "prompt",
      requestId: "r-main",
    });

    expectRecordFields(mockCallArg(hoisted.readAcpSessionEntryMock), {
      cfg,
      sessionKey: "agent:main:main",
    });
    expectRecordFields(mockCallArg(runtimeState.ensureSession), {
      agent: "main",
      sessionKey: "agent:main:main",
    });
  });

  it("tracks parented direct ACP turns in the task registry", async () => {
    await withAcpManagerTaskStateDir(async () => {
      const runtimeState = createRuntime();
      runtimeState.runTurn.mockImplementation(async function* () {
        yield {
          type: "text_delta" as const,
          stream: "output" as const,
          text: "Write failed: ",
        };
        yield {
          type: "text_delta" as const,
          stream: "output" as const,
          text: "permission ",
        };
        yield {
          type: "text_delta" as const,
          stream: "output" as const,
          text: "denied for ",
        };
        yield {
          type: "text_delta" as const,
          stream: "output" as const,
          text: "/root/",
        };
        yield {
          type: "text_delta" as const,
          stream: "output" as const,
          text: "oc-acp-write-",
        };
        yield {
          type: "text_delta" as const,
          stream: "output" as const,
          text: "should-fail.txt.",
        };
        yield { type: "done" as const };
      });
      hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
        id: "acpx",
        runtime: runtimeState.runtime,
      });
      hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
        const sessionKey = (paramsUnknown as { sessionKey?: string }).sessionKey;
        if (sessionKey === "agent:codex:acp:child-1") {
          return {
            sessionKey,
            storeSessionKey: sessionKey,
            entry: {
              sessionId: "child-1",
              updatedAt: Date.now(),
              spawnedBy: "agent:quant:telegram:quant:direct:822430204",
              label: "Quant patch",
            },
            acp: readySessionMeta(),
          };
        }
        if (sessionKey === "agent:quant:telegram:quant:direct:822430204") {
          return {
            sessionKey,
            storeSessionKey: sessionKey,
            entry: {
              sessionId: "parent-1",
              updatedAt: Date.now(),
            },
          };
        }
        return null;
      });

      const manager = new AcpSessionManager();
      await manager.runTurn({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:child-1",
        text: "Implement the feature and report back",
        mode: "prompt",
        requestId: "direct-parented-run",
      });
      await flushMicrotasks();

      expectRecordFields(requireTaskByRunId("direct-parented-run"), {
        runtime: "acp",
        ownerKey: "agent:quant:telegram:quant:direct:822430204",
        scopeKind: "session",
        childSessionKey: "agent:codex:acp:child-1",
        label: "Quant patch",
        task: "Implement the feature and report back",
        status: "succeeded",
        progressSummary: "Write failed: permission denied for /root/oc-acp-write-should-fail.txt.",
        terminalOutcome: "blocked",
        terminalSummary: "Permission denied for /root/oc-acp-write-should-fail.txt.",
      });
    });
  }, 300_000);

  it("preserves token-streamed ACP progress boundaries in parented task summaries", async () => {
    await withAcpManagerTaskStateDir(async () => {
      const runtimeState = createRuntime();
      const chunks = [
        "현재 ",
        "작업 ",
        "디",
        "렉토",
        "리는 ",
        "/home/",
        "by",
        "kim",
        "0119/",
        ".open",
        "claw/",
        "workspace",
        "\n\t",
        "입니다",
      ];
      runtimeState.runTurn.mockImplementation(async function* () {
        for (const text of chunks) {
          yield {
            type: "text_delta" as const,
            stream: "output" as const,
            text,
          };
        }
        yield { type: "done" as const };
      });
      hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
        id: "acpx",
        runtime: runtimeState.runtime,
      });
      hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
        const sessionKey = (paramsUnknown as { sessionKey?: string }).sessionKey;
        if (sessionKey === "agent:codex:acp:child-1") {
          return {
            sessionKey,
            storeSessionKey: sessionKey,
            entry: {
              sessionId: "child-1",
              updatedAt: Date.now(),
              spawnedBy: "agent:quant:telegram:quant:direct:822430204",
              label: "Korean path",
            },
            acp: readySessionMeta(),
          };
        }
        if (sessionKey === "agent:quant:telegram:quant:direct:822430204") {
          return {
            sessionKey,
            storeSessionKey: sessionKey,
            entry: {
              sessionId: "parent-1",
              updatedAt: Date.now(),
            },
          };
        }
        return null;
      });

      const manager = new AcpSessionManager();
      await manager.runTurn({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:child-1",
        text: "Print the current directory in Korean",
        mode: "prompt",
        requestId: "direct-parented-korean-path-run",
      });
      await flushMicrotasks();

      expectRecordFields(requireTaskByRunId("direct-parented-korean-path-run"), {
        runtime: "acp",
        ownerKey: "agent:quant:telegram:quant:direct:822430204",
        scopeKind: "session",
        childSessionKey: "agent:codex:acp:child-1",
        label: "Korean path",
        task: "Print the current directory in Korean",
        status: "succeeded",
        progressSummary: "현재 작업 디렉토리는 /home/bykim0119/.openclaw/workspace 입니다",
      });
    });
  }, 300_000);

  it("serializes concurrent turns for the same ACP session", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey: "agent:codex:acp:session-1",
      storeSessionKey: "agent:codex:acp:session-1",
      acp: readySessionMeta(),
    });

    let inFlight = 0;
    let maxInFlight = 0;
    const releaseFirstTurn = createDeferred();
    runtimeState.runTurn.mockImplementation(async function* (_input: { requestId: string }) {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        if (_input.requestId === "r1") {
          await releaseFirstTurn.promise;
        }
        yield { type: "done" };
      } finally {
        inFlight -= 1;
      }
    });

    const manager = new AcpSessionManager();
    const first = manager.runTurn({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-1",
      text: "first",
      mode: "prompt",
      requestId: "r1",
    });
    await vi.waitFor(
      () => {
        expect(runtimeState.runTurn).toHaveBeenCalledTimes(1);
      },
      { interval: 1 },
    );
    const second = manager.runTurn({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-1",
      text: "second",
      mode: "prompt",
      requestId: "r2",
    });
    await flushMicrotasks();
    expect(runtimeState.runTurn).toHaveBeenCalledTimes(1);
    releaseFirstTurn.resolve();
    await Promise.all([first, second]);

    expect(maxInFlight).toBe(1);
    expect(runtimeState.runTurn).toHaveBeenCalledTimes(2);
  });

  it("rejects a queued turn promptly when its caller aborts before the actor is free", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey: "agent:codex:acp:session-1",
      storeSessionKey: "agent:codex:acp:session-1",
      acp: readySessionMeta(),
    });

    let firstTurnStarted = false;
    let releaseFirstTurn: (() => void) | undefined;
    runtimeState.runTurn.mockImplementation(async function* (input: { requestId: string }) {
      if (input.requestId === "r1") {
        firstTurnStarted = true;
        await new Promise<void>((resolve) => {
          releaseFirstTurn = resolve;
        });
      }
      yield { type: "done" as const };
    });

    const manager = new AcpSessionManager();
    const first = manager.runTurn({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-1",
      text: "first",
      mode: "prompt",
      requestId: "r1",
    });
    await vi.waitFor(
      () => {
        expect(firstTurnStarted).toBe(true);
      },
      { interval: 1 },
    );

    const abortController = new AbortController();
    const second = manager.runTurn({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-1",
      text: "second",
      mode: "prompt",
      requestId: "r2",
      signal: abortController.signal,
    });
    abortController.abort();

    const secondOutcome = await Promise.race([
      second.then(
        () => ({ status: "resolved" as const }),
        (error) => ({ status: "rejected" as const, error }),
      ),
      new Promise<{ status: "pending" }>((resolve) => {
        scheduleNativeTimeout(() => resolve({ status: "pending" }), 100);
      }),
    ]);

    releaseFirstTurn?.();
    await first;
    await vi.waitFor(
      () => {
        expect(manager.getObservabilitySnapshot(baseCfg).turns.queueDepth).toBe(0);
      },
      { interval: 1 },
    );

    expect(secondOutcome.status).toBe("rejected");
    if (secondOutcome.status !== "rejected") {
      return;
    }
    expect(secondOutcome.error).toBeInstanceOf(AcpRuntimeError);
    expectRecordFields(secondOutcome.error, {
      code: "ACP_TURN_FAILED",
      message: "ACP operation aborted.",
    });
    expect(runtimeState.runTurn).toHaveBeenCalledTimes(1);
  });

  it("times out a hung persistent turn without closing the session and lets queued work continue", async () => {
    vi.useFakeTimers();
    try {
      const runtimeState = createRuntime();
      hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
        id: "acpx",
        runtime: runtimeState.runtime,
      });
      hoisted.readAcpSessionEntryMock.mockReturnValue({
        sessionKey: "agent:codex:acp:session-1",
        storeSessionKey: "agent:codex:acp:session-1",
        acp: readySessionMeta(),
      });

      let firstTurnStarted = false;
      runtimeState.runTurn.mockImplementation(async function* (input: { requestId: string }) {
        if (input.requestId === "r1") {
          firstTurnStarted = true;
          await new Promise(() => {});
        }
        yield { type: "done" as const };
      });

      const manager = new AcpSessionManager();
      const cfg = {
        ...baseCfg,
        agents: {
          defaults: {
            timeoutSeconds: 1,
          },
        },
      } as OpenClawConfig;

      const first = manager.runTurn({
        cfg,
        sessionKey: "agent:codex:acp:session-1",
        text: "first",
        mode: "prompt",
        requestId: "r1",
      });
      void first.catch(() => undefined);
      await vi.waitFor(
        () => {
          expect(firstTurnStarted).toBe(true);
        },
        { interval: 1 },
      );

      const second = manager.runTurn({
        cfg,
        sessionKey: "agent:codex:acp:session-1",
        text: "second",
        mode: "prompt",
        requestId: "r2",
      });

      await vi.advanceTimersByTimeAsync(3_500);

      await expectRejectedRecord(first, {
        code: "ACP_TURN_FAILED",
        message: "ACP turn timed out after 1s.",
      });
      await expect(second).resolves.toBeUndefined();

      expect(runtimeState.ensureSession).toHaveBeenCalledTimes(1);
      expect(runtimeState.runTurn).toHaveBeenCalledTimes(2);
      expectRecordFields(mockCallArg(runtimeState.cancel), {
        reason: "turn-timeout",
      });
      expect(runtimeState.close).not.toHaveBeenCalled();
      const snapshot = manager.getObservabilitySnapshot(cfg);
      expect(snapshot.runtimeCache.activeSessions).toBe(1);
      expectRecordFields(snapshot.turns, {
        active: 0,
        queueDepth: 0,
        completed: 1,
        failed: 1,
      });

      const states = extractStatesFromUpserts();
      expect(states).toContain("error");
      expect(states.at(-1)).toBe("idle");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps timed-out runtime handles counted until timeout cleanup finishes", async () => {
    vi.useFakeTimers();
    try {
      const runtimeState = createRuntime();
      runtimeState.cancel.mockImplementation(() => new Promise(() => {}));
      hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
        id: "acpx",
        runtime: runtimeState.runtime,
      });
      hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
        const sessionKey = (paramsUnknown as { sessionKey?: string }).sessionKey ?? "";
        return {
          sessionKey,
          storeSessionKey: sessionKey,
          acp: {
            ...readySessionMeta(),
            runtimeSessionName: `runtime:${sessionKey}`,
          },
        };
      });

      let firstTurnStarted = false;
      runtimeState.runTurn.mockImplementation(async function* (input: { requestId: string }) {
        if (input.requestId === "r1") {
          firstTurnStarted = true;
          await new Promise(() => {});
        }
        yield { type: "done" as const };
      });

      const manager = new AcpSessionManager();
      const cfg = {
        ...baseCfg,
        acp: {
          ...baseCfg.acp,
          maxConcurrentSessions: 1,
        },
        agents: {
          defaults: {
            timeoutSeconds: 1,
          },
        },
      } as OpenClawConfig;

      const first = manager.runTurn({
        cfg,
        sessionKey: "agent:codex:acp:session-a",
        text: "first",
        mode: "prompt",
        requestId: "r1",
      });
      void first.catch(() => undefined);
      await vi.waitFor(
        () => {
          expect(firstTurnStarted).toBe(true);
        },
        { interval: 1 },
      );

      await vi.advanceTimersByTimeAsync(4_500);

      await expectRejectedRecord(first, {
        code: "ACP_TURN_FAILED",
        message: "ACP turn timed out after 1s.",
      });
      expect(manager.getObservabilitySnapshot(cfg).runtimeCache.activeSessions).toBe(1);

      await expectRejectedRecord(
        manager.runTurn({
          cfg,
          sessionKey: "agent:codex:acp:session-b",
          text: "second",
          mode: "prompt",
          requestId: "r2",
        }),
        {
          code: "ACP_SESSION_INIT_FAILED",
          message: "ACP max concurrent sessions reached (1/1).",
        },
      );
      expect(runtimeState.ensureSession).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs turns for different ACP sessions in parallel", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const sessionKey = (paramsUnknown as { sessionKey?: string }).sessionKey ?? "";
      return {
        sessionKey,
        storeSessionKey: sessionKey,
        acp: {
          ...readySessionMeta(),
          runtimeSessionName: `runtime:${sessionKey}`,
        },
      };
    });

    let inFlight = 0;
    let maxInFlight = 0;
    const bothTurnsEntered = createDeferred();
    runtimeState.runTurn.mockImplementation(async function* () {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (inFlight === 2) {
        bothTurnsEntered.resolve();
      }
      try {
        await bothTurnsEntered.promise;
        yield { type: "done" as const };
      } finally {
        inFlight -= 1;
      }
    });

    const manager = new AcpSessionManager();
    await Promise.race([
      Promise.all([
        manager.runTurn({
          cfg: baseCfg,
          sessionKey: "agent:codex:acp:session-a",
          text: "first",
          mode: "prompt",
          requestId: "r1",
        }),
        manager.runTurn({
          cfg: baseCfg,
          sessionKey: "agent:codex:acp:session-b",
          text: "second",
          mode: "prompt",
          requestId: "r2",
        }),
      ]),
      sleep(100).then(() => {
        throw new Error("ACP sessions did not run in parallel");
      }),
    ]);

    expect(maxInFlight).toBe(2);
  });

  it("reuses runtime session handles for repeat turns in the same manager process", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey: "agent:codex:acp:session-1",
      storeSessionKey: "agent:codex:acp:session-1",
      acp: readySessionMeta(),
    });

    const manager = new AcpSessionManager();
    await manager.runTurn({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-1",
      text: "first",
      mode: "prompt",
      requestId: "r1",
    });
    await manager.runTurn({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-1",
      text: "second",
      mode: "prompt",
      requestId: "r2",
    });

    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(1);
    expect(runtimeState.runTurn).toHaveBeenCalledTimes(2);
  });

  it("re-ensures cached runtime handles when the backend reports the session is dead", async () => {
    const runtimeState = createRuntime();
    runtimeState.getStatus
      .mockResolvedValueOnce({
        summary: "status=alive",
        details: { status: "alive" },
      })
      .mockResolvedValueOnce({
        summary: "status=dead",
        details: { status: "dead" },
      })
      .mockResolvedValueOnce({
        summary: "status=alive",
        details: { status: "alive" },
      });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey: "agent:codex:acp:session-1",
      storeSessionKey: "agent:codex:acp:session-1",
      acp: readySessionMeta(),
    });

    const manager = new AcpSessionManager();
    await manager.runTurn({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-1",
      text: "first",
      mode: "prompt",
      requestId: "r1",
    });
    await manager.runTurn({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-1",
      text: "second",
      mode: "prompt",
      requestId: "r2",
    });

    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(2);
    expect(runtimeState.getStatus).toHaveBeenCalledTimes(3);
    expect(runtimeState.runTurn).toHaveBeenCalledTimes(2);
  });

  it("re-ensures cached runtime handles when persisted ACP session identity changes", async () => {
    const runtimeState = createRuntime();
    runtimeState.ensureSession
      .mockResolvedValueOnce({
        sessionKey: "agent:codex:acp:session-1",
        backend: "acpx",
        runtimeSessionName: "runtime-1",
        acpxRecordId: "record-1",
        backendSessionId: "acpx-session-1",
        agentSessionId: "agent-session-1",
      })
      .mockResolvedValueOnce({
        sessionKey: "agent:codex:acp:session-1",
        backend: "acpx",
        runtimeSessionName: "runtime-2",
        acpxRecordId: "record-1",
        backendSessionId: "acpx-session-2",
        agentSessionId: "agent-session-2",
      });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    let currentMeta = readySessionMeta({
      runtimeSessionName: "runtime-1",
      identity: {
        state: "resolved",
        acpxRecordId: "record-1",
        acpxSessionId: "acpx-session-1",
        agentSessionId: "agent-session-1",
        source: "status",
        lastUpdatedAt: Date.now(),
      },
    });
    hoisted.readAcpSessionEntryMock.mockImplementation(() => ({
      sessionKey: "agent:codex:acp:session-1",
      storeSessionKey: "agent:codex:acp:session-1",
      acp: currentMeta,
    }));

    const manager = new AcpSessionManager();
    await manager.runTurn({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-1",
      text: "first",
      mode: "prompt",
      requestId: "r1",
    });

    currentMeta = readySessionMeta({
      runtimeSessionName: "runtime-2",
      identity: {
        state: "resolved",
        acpxRecordId: "record-1",
        acpxSessionId: "acpx-session-2",
        agentSessionId: "agent-session-2",
        source: "status",
        lastUpdatedAt: Date.now(),
      },
    });

    await manager.runTurn({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-1",
      text: "second",
      mode: "prompt",
      requestId: "r2",
    });

    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(2);
    expect(runtimeState.runTurn).toHaveBeenCalledTimes(2);
  });

  it("rehydrates runtime handles after a manager restart", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey: "agent:codex:acp:session-1",
      storeSessionKey: "agent:codex:acp:session-1",
      acp: readySessionMeta(),
    });

    const managerA = new AcpSessionManager();
    await managerA.runTurn({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-1",
      text: "before restart",
      mode: "prompt",
      requestId: "r1",
    });
    const managerB = new AcpSessionManager();
    await managerB.runTurn({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-1",
      text: "after restart",
      mode: "prompt",
      requestId: "r2",
    });

    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(2);
  });

  it("passes persisted ACP backend session identity back into ensureSession for configured bindings after restart", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    const sessionKey = "agent:codex:acp:binding:demo-binding:default:deadbeef";
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const key = (paramsUnknown as { sessionKey?: string }).sessionKey ?? sessionKey;
      return {
        sessionKey: key,
        storeSessionKey: key,
        acp: {
          ...readySessionMeta(),
          runtimeSessionName: key,
          identity: {
            state: "resolved",
            source: "status",
            acpxSessionId: "acpx-sid-1",
            lastUpdatedAt: Date.now(),
          },
        },
      };
    });

    const manager = new AcpSessionManager();
    await manager.runTurn({
      cfg: baseCfg,
      sessionKey,
      text: "after restart",
      mode: "prompt",
      requestId: "r-binding-restart",
    });

    expectRecordFields(mockCallArg(runtimeState.ensureSession), {
      sessionKey,
      agent: "codex",
      resumeSessionId: "acpx-sid-1",
    });
  });

  it("prefers the persisted agent session id when reopening an ACP runtime after restart", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    const sessionKey = "agent:gemini:acp:binding:discord:default:restart";
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const key = (paramsUnknown as { sessionKey?: string }).sessionKey ?? sessionKey;
      return {
        sessionKey: key,
        storeSessionKey: key,
        acp: {
          ...readySessionMeta(),
          agent: "gemini",
          runtimeSessionName: key,
          identity: {
            state: "resolved",
            source: "status",
            acpxSessionId: "acpx-sid-1",
            agentSessionId: "gemini-sid-1",
            lastUpdatedAt: Date.now(),
          },
        },
      };
    });

    const manager = new AcpSessionManager();
    await manager.runTurn({
      cfg: baseCfg,
      sessionKey,
      text: "after restart",
      mode: "prompt",
      requestId: "r-binding-restart-gemini",
    });

    expectRecordFields(mockCallArg(runtimeState.ensureSession), {
      sessionKey,
      agent: "gemini",
      resumeSessionId: "gemini-sid-1",
    });
  });

  it("passes persisted cwd runtime options into ensureSession after restart", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    const sessionKey = "agent:codex:acp:binding:demo-binding:default:cwd-restart";
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const key = (paramsUnknown as { sessionKey?: string }).sessionKey ?? sessionKey;
      return {
        sessionKey: key,
        storeSessionKey: key,
        acp: {
          ...readySessionMeta(),
          cwd: "/workspace/stale",
          runtimeOptions: {
            cwd: "/workspace/project",
          },
        },
      };
    });

    const manager = new AcpSessionManager();
    await manager.runTurn({
      cfg: baseCfg,
      sessionKey,
      text: "after restart",
      mode: "prompt",
      requestId: "r-binding-restart-cwd",
    });

    expectRecordFields(mockCallArg(runtimeState.ensureSession), {
      sessionKey,
      cwd: "/workspace/project",
    });
  });

  it("passes persisted model runtime options into ensureSession after restart", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    const sessionKey = "agent:codex:acp:binding:demo-binding:default:model-restart";
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const key = (paramsUnknown as { sessionKey?: string }).sessionKey ?? sessionKey;
      return {
        sessionKey: key,
        storeSessionKey: key,
        acp: {
          ...readySessionMeta(),
          runtimeOptions: {
            model: "openai-codex/gpt-5.4",
          },
        },
      };
    });

    const manager = new AcpSessionManager();
    await manager.runTurn({
      cfg: baseCfg,
      sessionKey,
      text: "after restart",
      mode: "prompt",
      requestId: "r-binding-restart-model",
    });

    expectRecordFields(mockCallArg(runtimeState.ensureSession), {
      sessionKey,
      model: "openai-codex/gpt-5.4",
    });
  });

  it("passes persisted thinking runtime options into ensureSession after restart", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    const sessionKey = "agent:codex:acp:binding:demo-binding:default:thinking-restart";
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const key = (paramsUnknown as { sessionKey?: string }).sessionKey ?? sessionKey;
      return {
        sessionKey: key,
        storeSessionKey: key,
        acp: {
          ...readySessionMeta(),
          runtimeOptions: {
            thinking: "high",
          },
        },
      };
    });

    const manager = new AcpSessionManager();
    await manager.runTurn({
      cfg: baseCfg,
      sessionKey,
      text: "after restart",
      mode: "prompt",
      requestId: "r-binding-restart-thinking",
    });

    expectRecordFields(mockCallArg(runtimeState.ensureSession), {
      sessionKey,
      thinking: "high",
    });
  });

  it("does not resume persisted ACP identity for oneshot sessions after restart", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    const sessionKey = "agent:codex:acp:binding:demo-binding:default:oneshot";
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const key = (paramsUnknown as { sessionKey?: string }).sessionKey ?? sessionKey;
      return {
        sessionKey: key,
        storeSessionKey: key,
        acp: {
          ...readySessionMeta(),
          runtimeSessionName: key,
          mode: "oneshot",
          identity: {
            state: "resolved",
            source: "status",
            acpxSessionId: "acpx-sid-oneshot",
            lastUpdatedAt: Date.now(),
          },
        },
      };
    });

    const manager = new AcpSessionManager();
    await manager.runTurn({
      cfg: baseCfg,
      sessionKey,
      text: "after restart",
      mode: "prompt",
      requestId: "r-binding-oneshot",
    });

    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(1);
    const ensureInput = runtimeState.ensureSession.mock.calls[0]?.[0] as
      | { resumeSessionId?: string; mode?: string }
      | undefined;
    expectRecordFields(ensureInput, {
      sessionKey,
      agent: "codex",
      mode: "oneshot",
    });
    expect(ensureInput?.resumeSessionId).toBeUndefined();
  });

  it("falls back to a fresh ensure without reusing stale agent session ids", async () => {
    const runtimeState = createRuntime();
    runtimeState.ensureSession.mockImplementation(async (inputUnknown: unknown) => {
      const input = inputUnknown as {
        sessionKey: string;
        agent: string;
        mode: "persistent" | "oneshot";
        resumeSessionId?: string;
      };
      if (input.resumeSessionId) {
        throw new AcpRuntimeError(
          "ACP_SESSION_INIT_FAILED",
          "failed to resume persisted ACP session",
        );
      }
      return {
        sessionKey: input.sessionKey,
        backend: "acpx",
        runtimeSessionName: `${input.sessionKey}:${input.mode}:runtime`,
        backendSessionId: "acpx-sid-fresh",
      };
    });
    runtimeState.getStatus.mockResolvedValue({
      summary: "status=alive",
      backendSessionId: "acpx-sid-fresh",
      details: { status: "alive" },
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    const sessionKey = "agent:codex:acp:binding:demo-binding:default:retry-fresh";
    let currentMeta: SessionAcpMeta = {
      ...readySessionMeta(),
      runtimeSessionName: sessionKey,
      identity: {
        state: "resolved",
        source: "status",
        acpxSessionId: "acpx-sid-stale",
        agentSessionId: "agent-sid-stale",
        lastUpdatedAt: Date.now(),
      },
    };
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const key = (paramsUnknown as { sessionKey?: string }).sessionKey ?? sessionKey;
      return {
        sessionKey: key,
        storeSessionKey: key,
        acp: currentMeta,
      };
    });
    hoisted.upsertAcpSessionMetaMock.mockImplementation(async (paramsUnknown: unknown) => {
      const params = paramsUnknown as {
        mutate: (
          current: SessionAcpMeta | undefined,
          entry: { acp?: SessionAcpMeta } | undefined,
        ) => SessionAcpMeta | null | undefined;
      };
      const next = params.mutate(currentMeta, { acp: currentMeta });
      if (next) {
        currentMeta = next;
      }
      return {
        sessionId: "session-1",
        updatedAt: Date.now(),
        acp: currentMeta,
      };
    });

    const manager = new AcpSessionManager();
    await manager.runTurn({
      cfg: baseCfg,
      sessionKey,
      text: "after restart",
      mode: "prompt",
      requestId: "r-binding-retry-fresh",
    });

    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(2);
    expectRecordFields(mockCallArg(runtimeState.ensureSession), {
      sessionKey,
      agent: "codex",
      resumeSessionId: "agent-sid-stale",
    });
    const retryInput = runtimeState.ensureSession.mock.calls[1]?.[0] as
      | { resumeSessionId?: string }
      | undefined;
    expect(retryInput?.resumeSessionId).toBeUndefined();
    const runTurnInput = runtimeState.runTurn.mock.calls[0]?.[0] as
      | { handle?: { agentSessionId?: string; backendSessionId?: string } }
      | undefined;
    expect(runTurnInput?.handle?.backendSessionId).toBe("acpx-sid-fresh");
    expect(runTurnInput?.handle?.agentSessionId).toBeUndefined();
    expect(currentMeta.identity?.acpxSessionId).toBe("acpx-sid-fresh");
    expect(currentMeta.identity?.agentSessionId).toBeUndefined();
  });

  it("enforces acp.maxConcurrentSessions when opening new runtime handles", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const sessionKey = (paramsUnknown as { sessionKey?: string }).sessionKey ?? "";
      return {
        sessionKey,
        storeSessionKey: sessionKey,
        acp: {
          ...readySessionMeta(),
          runtimeSessionName: `runtime:${sessionKey}`,
        },
      };
    });
    const limitedCfg = {
      acp: {
        ...baseCfg.acp,
        maxConcurrentSessions: 1,
      },
    } as OpenClawConfig;

    const manager = new AcpSessionManager();
    await manager.runTurn({
      cfg: limitedCfg,
      sessionKey: "agent:codex:acp:session-a",
      text: "first",
      mode: "prompt",
      requestId: "r1",
    });

    await expectRejectedRecord(
      manager.runTurn({
        cfg: limitedCfg,
        sessionKey: "agent:codex:acp:session-b",
        text: "second",
        mode: "prompt",
        requestId: "r2",
      }),
      {
        code: "ACP_SESSION_INIT_FAILED",
        message: "ACP max concurrent sessions reached (1/1).",
      },
    );
    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(1);
  });

  it("enforces acp.maxConcurrentSessions during initializeSession", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.upsertAcpSessionMetaMock.mockResolvedValue({
      sessionKey: "agent:codex:acp:session-a",
      storeSessionKey: "agent:codex:acp:session-a",
      acp: readySessionMeta(),
    });
    const limitedCfg = {
      acp: {
        ...baseCfg.acp,
        maxConcurrentSessions: 1,
      },
    } as OpenClawConfig;

    const manager = new AcpSessionManager();
    await manager.initializeSession({
      cfg: limitedCfg,
      sessionKey: "agent:codex:acp:session-a",
      agent: "codex",
      mode: "persistent",
    });

    await expectRejectedRecord(
      manager.initializeSession({
        cfg: limitedCfg,
        sessionKey: "agent:codex:acp:session-b",
        agent: "codex",
        mode: "persistent",
      }),
      {
        code: "ACP_SESSION_INIT_FAILED",
        message: "ACP max concurrent sessions reached (1/1).",
      },
    );
    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(1);
  });

  it("persists runtime options provided during initializeSession", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.upsertAcpSessionMetaMock.mockResolvedValue({
      sessionKey: "agent:codex:acp:session-a",
      storeSessionKey: "agent:codex:acp:session-a",
      acp: readySessionMeta({
        runtimeOptions: {
          model: "openai-codex/gpt-5.4",
          thinking: "high",
        },
      }),
    });

    const manager = new AcpSessionManager();
    await manager.initializeSession({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-a",
      agent: "codex",
      mode: "persistent",
      runtimeOptions: {
        model: "openai-codex/gpt-5.4",
        thinking: "high",
      },
    });

    expect(extractRuntimeOptionsFromUpserts()).toContainEqual({
      model: "openai-codex/gpt-5.4",
      thinking: "high",
    });
    expectRecordFields(mockCallArg(runtimeState.ensureSession), {
      sessionKey: "agent:codex:acp:session-a",
      model: "openai-codex/gpt-5.4",
      thinking: "high",
    });
  });

  it("preserves runtimeOptions cwd when initializeSession cwd is omitted", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.upsertAcpSessionMetaMock.mockResolvedValue({
      sessionKey: "agent:codex:acp:session-cwd-runtime-options",
      storeSessionKey: "agent:codex:acp:session-cwd-runtime-options",
      acp: readySessionMeta({
        runtimeOptions: {
          cwd: "/workspace/from-runtime-options",
        },
        cwd: "/workspace/from-runtime-options",
      }),
    });

    const manager = new AcpSessionManager();
    await manager.initializeSession({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-cwd-runtime-options",
      agent: "codex",
      mode: "persistent",
      runtimeOptions: {
        cwd: "/workspace/from-runtime-options",
      },
    });

    expectRecordFields(mockCallArg(runtimeState.ensureSession), {
      sessionKey: "agent:codex:acp:session-cwd-runtime-options",
      cwd: "/workspace/from-runtime-options",
    });
    expect(extractRuntimeOptionsFromUpserts()).toContainEqual({
      cwd: "/workspace/from-runtime-options",
    });
  });

  it("drops cached runtime handles after tolerated close failures", async () => {
    const closeFailures = [
      {
        label: "backend unavailable",
        error: new AcpRuntimeError("ACP_BACKEND_UNAVAILABLE", "runtime temporarily unavailable"),
        notice: "temporarily unavailable",
      },
      {
        label: "stale acpx process exit",
        error: new Error("acpx exited with code 1"),
        notice: "acpx exited with code 1",
      },
    ];

    for (const testCase of closeFailures) {
      resetAcpSessionManagerForTests();
      const runtimeState = createRuntime();
      runtimeState.close.mockRejectedValueOnce(testCase.error);
      hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
        id: "acpx",
        runtime: runtimeState.runtime,
      });
      hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
        const sessionKey = (paramsUnknown as { sessionKey?: string }).sessionKey ?? "";
        return {
          sessionKey,
          storeSessionKey: sessionKey,
          acp: {
            ...readySessionMeta(),
            runtimeSessionName: `runtime:${sessionKey}`,
          },
        };
      });
      const limitedCfg = {
        acp: {
          ...baseCfg.acp,
          maxConcurrentSessions: 1,
        },
      } as OpenClawConfig;

      const manager = new AcpSessionManager();
      await manager.runTurn({
        cfg: limitedCfg,
        sessionKey: "agent:codex:acp:session-a",
        text: "first",
        mode: "prompt",
        requestId: "r1",
      });

      const closeResult = await manager.closeSession({
        cfg: limitedCfg,
        sessionKey: "agent:codex:acp:session-a",
        reason: "manual-close",
        allowBackendUnavailable: true,
      });
      expect(closeResult.runtimeClosed, testCase.label).toBe(false);
      expect(closeResult.runtimeNotice, testCase.label).toContain(testCase.notice);

      await expect(
        manager.runTurn({
          cfg: limitedCfg,
          sessionKey: "agent:codex:acp:session-b",
          text: "second",
          mode: "prompt",
          requestId: "r2",
        }),
        testCase.label,
      ).resolves.toBeUndefined();
      expect(runtimeState.ensureSession, testCase.label).toHaveBeenCalledTimes(2);
    }
  });

  it("treats stale session init failures as recoverable during discard resets", async () => {
    const runtimeState = createRuntime();
    runtimeState.ensureSession.mockRejectedValueOnce(
      new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "Could not initialize ACP session runtime."),
    );
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey: "agent:claude:acp:session-1",
      storeSessionKey: "agent:claude:acp:session-1",
      acp: readySessionMeta({
        agent: "claude",
      }),
    });

    const manager = new AcpSessionManager();
    const closeResult = await manager.closeSession({
      cfg: baseCfg,
      sessionKey: "agent:claude:acp:session-1",
      reason: "new-in-place-reset",
      allowBackendUnavailable: true,
      discardPersistentState: true,
    });

    expect(closeResult.runtimeClosed).toBe(false);
    expect(closeResult.runtimeNotice).toBe("Could not initialize ACP session runtime.");
    expect(runtimeState.prepareFreshSession).toHaveBeenCalledWith({
      sessionKey: "agent:claude:acp:session-1",
    });
  });

  it("treats unsupported close controls as recoverable during discard cleanup", async () => {
    const runtimeState = createRuntime();
    runtimeState.close.mockRejectedValueOnce(
      new AcpRuntimeError(
        "ACP_BACKEND_UNSUPPORTED_CONTROL",
        'ACP backend "acpx" does not support session/close.',
      ),
    );
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey: "agent:openclaw:acp:session-1",
      storeSessionKey: "agent:openclaw:acp:session-1",
      acp: readySessionMeta({
        agent: "openclaw",
      }),
    });

    const manager = new AcpSessionManager();
    const closeResult = await manager.closeSession({
      cfg: baseCfg,
      sessionKey: "agent:openclaw:acp:session-1",
      reason: "terminal-task-cleanup",
      allowBackendUnavailable: true,
      discardPersistentState: true,
      clearMeta: true,
    });

    expect(closeResult.runtimeClosed).toBe(false);
    expect(closeResult.runtimeNotice).toContain("does not support session/close");
    expect(closeResult.metaCleared).toBe(true);
    expect(runtimeState.prepareFreshSession).toHaveBeenCalledWith({
      sessionKey: "agent:openclaw:acp:session-1",
    });
  });

  it("clears persisted resume identity when close discards persistent state", async () => {
    const runtimeState = createRuntime();
    const sessionKey = "agent:claude:acp:binding:discord:default:9373ab192b2317f4";
    const entry = {
      sessionKey,
      storeSessionKey: sessionKey,
      acp: readySessionMeta({
        agent: "claude",
        state: "running",
        lastError: "stale failure",
        identity: {
          state: "resolved",
          acpxRecordId: sessionKey,
          acpxSessionId: "acpx-session-1",
          agentSessionId: "agent-session-1",
          source: "status",
          lastUpdatedAt: 1,
        },
      }),
    };
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockImplementation(() => entry);
    hoisted.upsertAcpSessionMetaMock.mockImplementation(async (paramsUnknown: unknown) => {
      const params = paramsUnknown as {
        mutate: (
          current: SessionAcpMeta | undefined,
          entry: { acp?: SessionAcpMeta } | undefined,
        ) => SessionAcpMeta | null | undefined;
      };
      const next = params.mutate(entry.acp, entry);
      if (next === null) {
        return null;
      }
      if (next) {
        entry.acp = next;
      }
      return entry;
    });

    const manager = new AcpSessionManager();
    const result = await manager.closeSession({
      cfg: baseCfg,
      sessionKey,
      reason: "new-in-place-reset",
      discardPersistentState: true,
      clearMeta: false,
      allowBackendUnavailable: true,
    });

    expect(result.runtimeClosed).toBe(true);
    expect(entry.acp?.state).toBe("idle");
    expect(entry.acp?.lastError).toBeUndefined();
    expectRecordFields(entry.acp?.identity, {
      state: "pending",
      acpxRecordId: sessionKey,
      source: "status",
    });
    expect(entry.acp?.identity).not.toHaveProperty("acpxSessionId");
    expect(entry.acp?.identity).not.toHaveProperty("agentSessionId");
  });

  it("prepares a fresh persistent session before ensure when metadata has no stable session id", async () => {
    const runtimeState = createRuntime();
    const sessionKey = "agent:claude:acp:binding:discord:default:9373ab192b2317f4";
    runtimeState.ensureSession.mockResolvedValue({
      sessionKey,
      backend: "acpx",
      runtimeSessionName: "runtime-fresh",
      acpxRecordId: sessionKey,
      backendSessionId: "acpx-session-fresh",
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });

    let currentMeta: SessionAcpMeta = readySessionMeta({
      agent: "claude",
      identity: {
        state: "pending",
        acpxRecordId: sessionKey,
        source: "status",
        lastUpdatedAt: Date.now(),
      },
    });
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const key = (paramsUnknown as { sessionKey?: string }).sessionKey ?? sessionKey;
      return {
        sessionKey: key,
        storeSessionKey: key,
        acp: currentMeta,
      };
    });
    hoisted.upsertAcpSessionMetaMock.mockImplementation(async (paramsUnknown: unknown) => {
      const params = paramsUnknown as {
        mutate: (
          current: SessionAcpMeta | undefined,
          entry: { acp?: SessionAcpMeta } | undefined,
        ) => SessionAcpMeta | null | undefined;
      };
      const next = params.mutate(currentMeta, { acp: currentMeta });
      if (next) {
        currentMeta = next;
      }
      return {
        sessionId: "session-1",
        updatedAt: Date.now(),
        acp: currentMeta,
      };
    });

    const manager = new AcpSessionManager();
    await expect(
      manager.runTurn({
        cfg: baseCfg,
        sessionKey,
        text: "who are you?",
        mode: "prompt",
        requestId: "r-fresh",
      }),
    ).resolves.toBeUndefined();

    expect(runtimeState.prepareFreshSession).toHaveBeenCalledWith({
      sessionKey,
    });
    expectRecordFields(mockCallArg(runtimeState.ensureSession), {
      sessionKey,
    });
    expect(runtimeState.prepareFreshSession.mock.invocationCallOrder[0]).toBeLessThan(
      runtimeState.ensureSession.mock.invocationCallOrder[0],
    );
  });

  it("skips runtime re-ensure when discarding a pending persistent session", async () => {
    const runtimeState = createRuntime();
    const sessionKey = "agent:claude:acp:binding:discord:default:9373ab192b2317f4";
    hoisted.getAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });

    const entry = {
      sessionKey,
      storeSessionKey: sessionKey,
      acp: readySessionMeta({
        agent: "claude",
        identity: {
          state: "pending",
          acpxRecordId: sessionKey,
          source: "ensure",
          lastUpdatedAt: Date.now(),
        },
      }),
    };
    hoisted.readAcpSessionEntryMock.mockImplementation(() => entry);
    hoisted.upsertAcpSessionMetaMock.mockImplementation(async (paramsUnknown: unknown) => {
      const params = paramsUnknown as {
        mutate: (
          current: SessionAcpMeta | undefined,
          entry: { acp?: SessionAcpMeta } | undefined,
        ) => SessionAcpMeta | null | undefined;
      };
      const next = params.mutate(entry.acp, entry);
      if (next === null) {
        return null;
      }
      if (next) {
        entry.acp = next;
      }
      return entry;
    });

    const manager = new AcpSessionManager();
    const result = await manager.closeSession({
      cfg: baseCfg,
      sessionKey,
      reason: "new-in-place-reset",
      discardPersistentState: true,
      clearMeta: false,
      allowBackendUnavailable: true,
    });

    expect(result.runtimeClosed).toBe(false);
    expect(runtimeState.prepareFreshSession).toHaveBeenCalledWith({
      sessionKey,
    });
    expect(runtimeState.ensureSession).not.toHaveBeenCalled();
    expect(runtimeState.close).not.toHaveBeenCalled();
    expectRecordFields(entry.acp?.identity, {
      state: "pending",
      acpxRecordId: sessionKey,
      source: "ensure",
    });
    expect(entry.acp?.identity).not.toHaveProperty("acpxSessionId");
    expect(entry.acp?.identity).not.toHaveProperty("agentSessionId");
  });

  it("evicts idle cached runtimes before enforcing max concurrent limits", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-02-23T00:00:00.000Z"));
      const runtimeState = createRuntime();
      hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
        id: "acpx",
        runtime: runtimeState.runtime,
      });
      hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
        const sessionKey = (paramsUnknown as { sessionKey?: string }).sessionKey ?? "";
        return {
          sessionKey,
          storeSessionKey: sessionKey,
          acp: {
            ...readySessionMeta(),
            runtimeSessionName: `runtime:${sessionKey}`,
          },
        };
      });
      const cfg = {
        acp: {
          ...baseCfg.acp,
          maxConcurrentSessions: 1,
          runtime: {
            ttlMinutes: 0.01,
          },
        },
      } as OpenClawConfig;

      const manager = new AcpSessionManager();
      await manager.runTurn({
        cfg,
        sessionKey: "agent:codex:acp:session-a",
        text: "first",
        mode: "prompt",
        requestId: "r1",
      });

      vi.advanceTimersByTime(2_000);
      await manager.runTurn({
        cfg,
        sessionKey: "agent:codex:acp:session-b",
        text: "second",
        mode: "prompt",
        requestId: "r2",
      });

      expect(runtimeState.ensureSession).toHaveBeenCalledTimes(2);
      const closeInput = mockCallArg(runtimeState.close);
      expectRecordFields(closeInput, {
        reason: "idle-evicted",
      });
      expectRecordFields(closeInput.handle, {
        sessionKey: "agent:codex:acp:session-a",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("tracks ACP turn latency and error-code observability", async () => {
    const runtimeState = createRuntime();
    runtimeState.runTurn.mockImplementation(async function* (input: { requestId: string }) {
      if (input.requestId === "fail") {
        throw new Error("runtime exploded");
      }
      yield { type: "done" as const };
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const sessionKey = (paramsUnknown as { sessionKey?: string }).sessionKey ?? "";
      return {
        sessionKey,
        storeSessionKey: sessionKey,
        acp: {
          ...readySessionMeta(),
          runtimeSessionName: `runtime:${sessionKey}`,
        },
      };
    });

    const manager = new AcpSessionManager();
    await manager.runTurn({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-1",
      text: "ok",
      mode: "prompt",
      requestId: "ok",
    });
    await expectRejectedRecord(
      manager.runTurn({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:session-1",
        text: "boom",
        mode: "prompt",
        requestId: "fail",
      }),
      { code: "ACP_TURN_FAILED" },
    );

    const snapshot = manager.getObservabilitySnapshot(baseCfg);
    expect(snapshot.turns.completed).toBe(1);
    expect(snapshot.turns.failed).toBe(1);
    expect(snapshot.turns.active).toBe(0);
    expect(snapshot.turns.queueDepth).toBe(0);
    expect(snapshot.errorsByCode.ACP_TURN_FAILED).toBe(1);
  });

  it("rolls back ensured runtime sessions when metadata persistence fails", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.upsertAcpSessionMetaMock.mockRejectedValueOnce(new Error("disk full"));

    const manager = new AcpSessionManager();
    await expect(
      manager.initializeSession({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:session-1",
        agent: "codex",
        mode: "persistent",
      }),
    ).rejects.toThrow("disk full");
    const closeInput = mockCallArg(runtimeState.close);
    expectRecordFields(closeInput, {
      reason: "init-meta-failed",
    });
    expectRecordFields(closeInput.handle, {
      sessionKey: "agent:codex:acp:session-1",
    });
  });

  it("preempts an active turn on cancel and returns to idle state", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey: "agent:codex:acp:session-1",
      storeSessionKey: "agent:codex:acp:session-1",
      acp: readySessionMeta(),
    });

    let enteredRun = false;
    runtimeState.runTurn.mockImplementation(async function* (input: { signal?: AbortSignal }) {
      enteredRun = true;
      await new Promise<void>((resolve) => {
        if (input.signal?.aborted) {
          resolve();
          return;
        }
        input.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      yield { type: "done" as const, stopReason: "cancel" };
    });

    const manager = new AcpSessionManager();
    const runPromise = manager.runTurn({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-1",
      text: "long task",
      mode: "prompt",
      requestId: "run-1",
    });
    await vi.waitFor(
      () => {
        expect(enteredRun).toBe(true);
      },
      { interval: 1 },
    );

    await manager.cancelSession({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-1",
      reason: "manual-cancel",
    });
    await runPromise;

    expect(runtimeState.cancel).toHaveBeenCalledTimes(1);
    expectRecordFields(mockCallArg(runtimeState.cancel), {
      reason: "manual-cancel",
    });
    const states = extractStatesFromUpserts();
    expect(states).toContain("running");
    expect(states).toContain("idle");
    expect(states).not.toContain("error");
  });

  it("cleans actor-tail bookkeeping after session turns complete", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const sessionKey = (paramsUnknown as { sessionKey?: string }).sessionKey ?? "";
      return {
        sessionKey,
        storeSessionKey: sessionKey,
        acp: {
          ...readySessionMeta(),
          runtimeSessionName: `runtime:${sessionKey}`,
        },
      };
    });
    runtimeState.runTurn.mockImplementation(async function* () {
      yield { type: "done" as const };
    });

    const manager = new AcpSessionManager();
    await manager.runTurn({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-a",
      text: "first",
      mode: "prompt",
      requestId: "r1",
    });
    await manager.runTurn({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-b",
      text: "second",
      mode: "prompt",
      requestId: "r2",
    });

    const internals = manager as unknown as {
      actorQueue: { getTailMapForTesting(): Map<string, Promise<void>> };
    };
    expect(internals.actorQueue.getTailMapForTesting().size).toBe(0);
  });

  it("surfaces backend failures raised after a done event", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey: "agent:codex:acp:session-1",
      storeSessionKey: "agent:codex:acp:session-1",
      acp: readySessionMeta(),
    });
    runtimeState.runTurn.mockImplementation(async function* () {
      yield { type: "done" as const };
      throw new Error("acpx exited with code 1");
    });

    const manager = new AcpSessionManager();
    await expectRejectedRecord(
      manager.runTurn({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:session-1",
        text: "do work",
        mode: "prompt",
        requestId: "run-1",
      }),
      {
        code: "ACP_TURN_FAILED",
        message: "acpx exited with code 1",
      },
    );

    const states = extractStatesFromUpserts();
    expect(states).toContain("running");
    expect(states).toContain("error");
    expect(states.at(-1)).toBe("error");
  });

  it("rejects ACP streams that end without a terminal done event", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey: "agent:codex:acp:session-1",
      storeSessionKey: "agent:codex:acp:session-1",
      acp: readySessionMeta(),
    });
    runtimeState.runTurn.mockImplementation(async function* () {
      yield {
        type: "text_delta" as const,
        stream: "output" as const,
        text: "Starting work...",
      };
    });

    const manager = new AcpSessionManager();
    await expectRejectedRecord(
      manager.runTurn({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:session-1",
        text: "do work",
        mode: "prompt",
        requestId: "run-1",
      }),
      {
        code: "ACP_TURN_FAILED",
        message: "ACP turn ended without a terminal done event.",
      },
    );

    const states = extractStatesFromUpserts();
    expect(states).toContain("running");
    expect(states.at(-1)).toBe("error");
  });

  it("marks the session as errored when runtime ensure fails before turn start", async () => {
    const runtimeState = createRuntime();
    runtimeState.ensureSession.mockRejectedValue(new Error("acpx exited with code 1"));
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey: "agent:codex:acp:session-1",
      storeSessionKey: "agent:codex:acp:session-1",
      acp: {
        ...readySessionMeta(),
        state: "running",
      },
    });

    const manager = new AcpSessionManager();
    await expectRejectedRecord(
      manager.runTurn({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:session-1",
        text: "do work",
        mode: "prompt",
        requestId: "run-1",
      }),
      {
        code: "ACP_SESSION_INIT_FAILED",
        message: "acpx exited with code 1",
      },
    );

    const states = extractStatesFromUpserts();
    expect(states).not.toContain("running");
    expect(states.at(-1)).toBe("error");
  });

  it("retries once with a fresh runtime handle after early acpx exits", async () => {
    for (const message of ["acpx exited with code 1", "acpx exited with signal SIGTERM"]) {
      hoisted.upsertAcpSessionMetaMock.mockClear();
      const runtimeState = createRuntime();
      hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
        id: "acpx",
        runtime: runtimeState.runtime,
      });
      hoisted.readAcpSessionEntryMock.mockReturnValue({
        sessionKey: "agent:codex:acp:session-1",
        storeSessionKey: "agent:codex:acp:session-1",
        acp: readySessionMeta(),
      });
      runtimeState.runTurn
        .mockImplementationOnce(async function* () {
          yield {
            type: "error" as const,
            message,
          };
        })
        .mockImplementationOnce(async function* () {
          yield { type: "done" as const };
        });

      const manager = new AcpSessionManager();
      await expect(
        manager.runTurn({
          cfg: baseCfg,
          sessionKey: "agent:codex:acp:session-1",
          text: "do work",
          mode: "prompt",
          requestId: "run-1",
        }),
        message,
      ).resolves.toBeUndefined();

      expect(runtimeState.ensureSession, message).toHaveBeenCalledTimes(2);
      expect(runtimeState.runTurn, message).toHaveBeenCalledTimes(2);
      const states = extractStatesFromUpserts();
      expect(states, message).toContain("running");
      expect(states, message).toContain("idle");
      expect(states, message).not.toContain("error");
      resetAcpSessionManagerForTests();
    }
  });

  it("retries once with a fresh persistent session after an early missing-session turn failure", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    const sessionKey = "agent:claude:acp:binding:discord:default:retry-no-session";
    let currentMeta: SessionAcpMeta = {
      ...readySessionMeta({
        agent: "claude",
      }),
      runtimeSessionName: sessionKey,
      identity: {
        state: "resolved",
        source: "status",
        acpxSessionId: "acpx-sid-stale",
        lastUpdatedAt: Date.now(),
      },
    };
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const key = (paramsUnknown as { sessionKey?: string }).sessionKey ?? sessionKey;
      return {
        sessionKey: key,
        storeSessionKey: key,
        acp: currentMeta,
      };
    });
    hoisted.upsertAcpSessionMetaMock.mockImplementation(async (paramsUnknown: unknown) => {
      const params = paramsUnknown as {
        mutate: (
          current: SessionAcpMeta | undefined,
          entry: { acp?: SessionAcpMeta } | undefined,
        ) => SessionAcpMeta | null | undefined;
      };
      const next = params.mutate(currentMeta, { acp: currentMeta });
      if (next) {
        currentMeta = next;
      }
      return {
        sessionId: "session-1",
        updatedAt: Date.now(),
        acp: currentMeta,
      };
    });
    runtimeState.ensureSession.mockImplementation(async (inputUnknown: unknown) => {
      const input = inputUnknown as {
        sessionKey: string;
        mode: "persistent" | "oneshot";
        resumeSessionId?: string;
      };
      return {
        sessionKey: input.sessionKey,
        backend: "acpx",
        runtimeSessionName: `${input.sessionKey}:${input.mode}:runtime`,
        backendSessionId: input.resumeSessionId ? "acpx-sid-stale" : "acpx-sid-fresh",
      };
    });
    runtimeState.getStatus.mockResolvedValue({
      summary: "status=alive",
      backendSessionId: "acpx-sid-fresh",
      details: { status: "alive" },
    });
    runtimeState.runTurn
      .mockImplementationOnce(async function* () {
        yield {
          type: "error" as const,
          code: "NO_SESSION",
          message:
            "Persistent ACP session acpx-sid-stale could not be resumed: Resource not found: acpx-sid-stale",
        };
      })
      .mockImplementationOnce(async function* () {
        yield { type: "done" as const };
      });

    const manager = new AcpSessionManager();
    await expect(
      manager.runTurn({
        cfg: baseCfg,
        sessionKey,
        text: "do work",
        mode: "prompt",
        requestId: "run-no-session",
      }),
    ).resolves.toBeUndefined();

    expect(runtimeState.prepareFreshSession).toHaveBeenCalledWith({
      sessionKey,
    });
    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(2);
    expectRecordFields(mockCallArg(runtimeState.ensureSession), {
      sessionKey,
      resumeSessionId: "acpx-sid-stale",
    });
    const retryInput = runtimeState.ensureSession.mock.calls[1]?.[0] as
      | { resumeSessionId?: string }
      | undefined;
    expect(retryInput?.resumeSessionId).toBeUndefined();
    expect(currentMeta.identity?.acpxSessionId).toBe("acpx-sid-fresh");
    expect(currentMeta.identity?.state).toBe("resolved");
    const states = extractStatesFromUpserts();
    expect(states).toContain("running");
    expect(states).toContain("idle");
    expect(states).not.toContain("error");
  });

  it("persists runtime mode changes through setSessionRuntimeMode", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey: "agent:codex:acp:session-1",
      storeSessionKey: "agent:codex:acp:session-1",
      acp: readySessionMeta(),
    });

    const manager = new AcpSessionManager();
    const options = await manager.setSessionRuntimeMode({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-1",
      runtimeMode: "plan",
    });

    expectMockCallFields(runtimeState.setMode, {
      mode: "plan",
    });
    expect(options.runtimeMode).toBe("plan");
    const persistedRuntimeModes = extractRuntimeOptionsFromUpserts().map(
      (entry) => entry?.runtimeMode,
    );
    expect(persistedRuntimeModes).toContain("plan");
  });

  it("reapplies persisted controls on next turn after runtime option updates", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });

    let currentMeta: SessionAcpMeta = {
      ...readySessionMeta(),
      runtimeOptions: {
        runtimeMode: "plan",
      },
    };
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const sessionKey =
        (paramsUnknown as { sessionKey?: string }).sessionKey ?? "agent:codex:acp:session-1";
      return {
        sessionKey,
        storeSessionKey: sessionKey,
        acp: currentMeta,
      };
    });
    hoisted.upsertAcpSessionMetaMock.mockImplementation(async (paramsUnknown: unknown) => {
      const params = paramsUnknown as {
        mutate: (
          current: SessionAcpMeta | undefined,
          entry: { acp?: SessionAcpMeta } | undefined,
        ) => SessionAcpMeta | null | undefined;
      };
      const next = params.mutate(currentMeta, { acp: currentMeta });
      if (next) {
        currentMeta = next;
      }
      return {
        sessionId: "session-1",
        updatedAt: Date.now(),
        acp: currentMeta,
      };
    });

    const manager = new AcpSessionManager();
    await manager.setSessionConfigOption({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-1",
      key: "model",
      value: "openai-codex/gpt-5.4",
    });
    expect(runtimeState.setMode).not.toHaveBeenCalled();

    await manager.runTurn({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-1",
      text: "do work",
      mode: "prompt",
      requestId: "run-1",
    });

    expectMockCallFields(runtimeState.setMode, {
      mode: "plan",
    });
  });

  it("reconciles persisted ACP session identifiers from runtime status after a turn", async () => {
    const runtimeState = createRuntime();
    runtimeState.ensureSession.mockResolvedValue({
      sessionKey: "agent:codex:acp:session-1",
      backend: "acpx",
      runtimeSessionName: "runtime-1",
      backendSessionId: "acpx-stale",
      agentSessionId: "agent-stale",
    });
    runtimeState.getStatus.mockResolvedValue({
      summary: "status=alive",
      backendSessionId: "acpx-fresh",
      agentSessionId: "agent-fresh",
      details: { status: "alive" },
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });

    let currentMeta: SessionAcpMeta = {
      ...readySessionMeta(),
      identity: {
        state: "resolved",
        source: "status",
        acpxSessionId: "acpx-stale",
        agentSessionId: "agent-stale",
        lastUpdatedAt: Date.now(),
      },
    };
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const sessionKey =
        (paramsUnknown as { sessionKey?: string }).sessionKey ?? "agent:codex:acp:session-1";
      return {
        sessionKey,
        storeSessionKey: sessionKey,
        acp: currentMeta,
      };
    });
    hoisted.upsertAcpSessionMetaMock.mockImplementation(async (paramsUnknown: unknown) => {
      const params = paramsUnknown as {
        mutate: (
          current: SessionAcpMeta | undefined,
          entry: { acp?: SessionAcpMeta } | undefined,
        ) => SessionAcpMeta | null | undefined;
      };
      const next = params.mutate(currentMeta, { acp: currentMeta });
      if (next) {
        currentMeta = next;
      }
      return {
        sessionId: "session-1",
        updatedAt: Date.now(),
        acp: currentMeta,
      };
    });

    const manager = new AcpSessionManager();
    await manager.runTurn({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-1",
      text: "do work",
      mode: "prompt",
      requestId: "run-1",
    });

    expect(runtimeState.getStatus).toHaveBeenCalledTimes(1);
    expect(currentMeta.identity?.acpxSessionId).toBe("acpx-fresh");
    expect(currentMeta.identity?.agentSessionId).toBe("agent-fresh");
  });

  it("reconciles oneshot ACP identity from runtime status before closing after a turn", async () => {
    const runtimeState = createRuntime();
    runtimeState.ensureSession.mockResolvedValue({
      sessionKey: "agent:codex:acp:session-1",
      backend: "acpx",
      runtimeSessionName: "runtime-1",
      backendSessionId: "acpx-oneshot",
    });
    runtimeState.getStatus.mockResolvedValue({
      summary: "status=done",
      backendSessionId: "acpx-oneshot",
      agentSessionId: "agent-oneshot",
      details: { status: "done" },
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });

    let currentMeta: SessionAcpMeta | undefined;
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const sessionKey =
        (paramsUnknown as { sessionKey?: string }).sessionKey ?? "agent:codex:acp:session-1";
      return {
        sessionKey,
        storeSessionKey: sessionKey,
        acp: currentMeta,
      };
    });
    hoisted.upsertAcpSessionMetaMock.mockImplementation(async (paramsUnknown: unknown) => {
      const params = paramsUnknown as {
        mutate: (
          current: SessionAcpMeta | undefined,
          entry: { acp?: SessionAcpMeta } | undefined,
        ) => SessionAcpMeta | null | undefined;
      };
      const next = params.mutate(currentMeta, { acp: currentMeta });
      if (next) {
        currentMeta = next;
      }
      return {
        sessionId: "session-1",
        updatedAt: Date.now(),
        acp: currentMeta,
      };
    });

    const manager = new AcpSessionManager();
    await manager.initializeSession({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-1",
      agent: "codex",
      mode: "oneshot",
    });

    expectRecordFields(currentMeta?.identity, {
      state: "pending",
      acpxSessionId: "acpx-oneshot",
      source: "ensure",
    });

    await manager.runTurn({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-1",
      text: "do work",
      mode: "prompt",
      requestId: "run-1",
    });

    expect(runtimeState.getStatus).toHaveBeenCalledTimes(2);
    const closeInput = mockCallArg(runtimeState.close);
    expectRecordFields(closeInput, {
      reason: "oneshot-complete",
    });
    expectRecordFields(closeInput.handle, {
      backendSessionId: "acpx-oneshot",
      agentSessionId: "agent-oneshot",
    });
    expectRecordFields(currentMeta?.identity, {
      state: "resolved",
      acpxSessionId: "acpx-oneshot",
      agentSessionId: "agent-oneshot",
      source: "status",
    });
  });

  it("reconciles pending ACP identities during startup scan", async () => {
    const runtimeState = createRuntime();
    runtimeState.getStatus.mockResolvedValue({
      summary: "status=alive",
      acpxRecordId: "acpx-record-1",
      backendSessionId: "acpx-session-1",
      agentSessionId: "agent-session-1",
      details: { status: "alive" },
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });

    let currentMeta: SessionAcpMeta = {
      ...readySessionMeta(),
      identity: {
        state: "pending",
        source: "ensure",
        acpxSessionId: "acpx-stale",
        lastUpdatedAt: Date.now(),
      },
    };
    const sessionKey = "agent:codex:acp:session-1";
    hoisted.listAcpSessionEntriesMock.mockResolvedValue([
      {
        cfg: baseCfg,
        storePath: "/tmp/sessions-acp.json",
        sessionKey,
        storeSessionKey: sessionKey,
        entry: {
          sessionId: "session-1",
          updatedAt: Date.now(),
          acp: currentMeta,
        },
        acp: currentMeta,
      },
    ]);
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const key = (paramsUnknown as { sessionKey?: string }).sessionKey ?? sessionKey;
      return {
        sessionKey: key,
        storeSessionKey: key,
        acp: currentMeta,
      };
    });
    hoisted.upsertAcpSessionMetaMock.mockImplementation(async (paramsUnknown: unknown) => {
      const params = paramsUnknown as {
        mutate: (
          current: SessionAcpMeta | undefined,
          entry: { acp?: SessionAcpMeta } | undefined,
        ) => SessionAcpMeta | null | undefined;
      };
      const next = params.mutate(currentMeta, { acp: currentMeta });
      if (next) {
        currentMeta = next;
      }
      return {
        sessionId: "session-1",
        updatedAt: Date.now(),
        acp: currentMeta,
      };
    });

    const manager = new AcpSessionManager();
    const result = await manager.reconcilePendingSessionIdentities({ cfg: baseCfg });

    expect(result).toEqual({ checked: 1, resolved: 1, failed: 0 });
    expect(currentMeta.identity?.state).toBe("resolved");
    expect(currentMeta.identity?.acpxRecordId).toBe("acpx-record-1");
    expect(currentMeta.identity?.acpxSessionId).toBe("acpx-session-1");
    expect(currentMeta.identity?.agentSessionId).toBe("agent-session-1");
  });

  it("skips startup reconcile for pending identities without stable runtime ids", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });

    const sessionKey = "agent:claude:acp:binding:discord:default:9373ab192b2317f4";
    hoisted.listAcpSessionEntriesMock.mockResolvedValue([
      {
        cfg: baseCfg,
        storePath: "/tmp/sessions-acp.json",
        sessionKey,
        storeSessionKey: sessionKey,
        entry: {
          sessionId: "session-1",
          updatedAt: Date.now(),
          acp: {
            ...readySessionMeta({
              agent: "claude",
            }),
            identity: {
              state: "pending",
              acpxRecordId: sessionKey,
              source: "status",
              lastUpdatedAt: Date.now(),
            },
          },
        },
        acp: {
          ...readySessionMeta({
            agent: "claude",
          }),
          identity: {
            state: "pending",
            acpxRecordId: sessionKey,
            source: "status",
            lastUpdatedAt: Date.now(),
          },
        },
      },
    ]);

    const manager = new AcpSessionManager();
    const result = await manager.reconcilePendingSessionIdentities({ cfg: baseCfg });

    expect(result).toEqual({ checked: 0, resolved: 0, failed: 0 });
    expect(runtimeState.ensureSession).not.toHaveBeenCalled();
    expect(runtimeState.getStatus).not.toHaveBeenCalled();
  });

  it("reconciles prompt-learned agent session IDs even when runtime status omits them", async () => {
    const runtimeState = createRuntime();
    runtimeState.ensureSession.mockResolvedValue({
      sessionKey: "agent:gemini:acp:session-1",
      backend: "acpx",
      runtimeSessionName: "runtime-3",
      backendSessionId: "acpx-stale",
    });
    runtimeState.runTurn.mockImplementation(async function* (inputUnknown: unknown) {
      const input = inputUnknown as {
        handle: {
          agentSessionId?: string;
        };
      };
      input.handle.agentSessionId = "gemini-session-1";
      yield { type: "done" as const };
    });
    runtimeState.getStatus.mockResolvedValue({
      summary: "status=alive",
      details: { status: "alive" },
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });

    let currentMeta: SessionAcpMeta = {
      ...readySessionMeta(),
      agent: "gemini",
      identity: {
        state: "pending",
        source: "ensure",
        acpxSessionId: "acpx-stale",
        lastUpdatedAt: Date.now(),
      },
    };
    const sessionKey = "agent:gemini:acp:session-1";
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const key = (paramsUnknown as { sessionKey?: string }).sessionKey ?? sessionKey;
      return {
        sessionKey: key,
        storeSessionKey: key,
        acp: currentMeta,
      };
    });
    hoisted.upsertAcpSessionMetaMock.mockImplementation(async (paramsUnknown: unknown) => {
      const params = paramsUnknown as {
        mutate: (
          current: SessionAcpMeta | undefined,
          entry: { acp?: SessionAcpMeta } | undefined,
        ) => SessionAcpMeta | null | undefined;
      };
      const next = params.mutate(currentMeta, { acp: currentMeta });
      if (next) {
        currentMeta = next;
      }
      return {
        sessionId: "session-1",
        updatedAt: Date.now(),
        acp: currentMeta,
      };
    });

    const manager = new AcpSessionManager();
    await manager.runTurn({
      cfg: baseCfg,
      sessionKey,
      text: "learn prompt session",
      mode: "prompt",
      requestId: "run-prompt-learned-agent-id",
    });

    expect(currentMeta.identity?.state).toBe("resolved");
    expect(currentMeta.identity?.agentSessionId).toBe("gemini-session-1");
    expect(currentMeta.identity?.acpxSessionId).toBe("acpx-stale");
  });

  it("skips startup identity reconciliation for already resolved sessions", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    const sessionKey = "agent:codex:acp:session-1";
    const resolvedMeta: SessionAcpMeta = {
      ...readySessionMeta(),
      identity: {
        state: "resolved",
        source: "status",
        acpxSessionId: "acpx-sid-1",
        agentSessionId: "agent-sid-1",
        lastUpdatedAt: Date.now(),
      },
    };
    hoisted.listAcpSessionEntriesMock.mockResolvedValue([
      {
        cfg: baseCfg,
        storePath: "/tmp/sessions-acp.json",
        sessionKey,
        storeSessionKey: sessionKey,
        entry: {
          sessionId: "session-1",
          updatedAt: Date.now(),
          acp: resolvedMeta,
        },
        acp: resolvedMeta,
      },
    ]);

    const manager = new AcpSessionManager();
    const result = await manager.reconcilePendingSessionIdentities({ cfg: baseCfg });

    expect(result).toEqual({ checked: 0, resolved: 0, failed: 0 });
    expect(runtimeState.getStatus).not.toHaveBeenCalled();
    expect(runtimeState.ensureSession).not.toHaveBeenCalled();
  });

  it("preserves existing ACP session identifiers when ensure returns none", async () => {
    const runtimeState = createRuntime();
    runtimeState.ensureSession.mockResolvedValue({
      sessionKey: "agent:codex:acp:session-1",
      backend: "acpx",
      runtimeSessionName: "runtime-2",
    });
    runtimeState.getStatus.mockResolvedValue({
      summary: "status=alive",
      details: { status: "alive" },
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey: "agent:codex:acp:session-1",
      storeSessionKey: "agent:codex:acp:session-1",
      acp: {
        ...readySessionMeta(),
        identity: {
          state: "resolved",
          source: "status",
          acpxSessionId: "acpx-stable",
          agentSessionId: "agent-stable",
          lastUpdatedAt: Date.now(),
        },
      },
    });

    const manager = new AcpSessionManager();
    const status = await manager.getSessionStatus({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-1",
    });

    expect(status.identity?.acpxSessionId).toBe("acpx-stable");
    expect(status.identity?.agentSessionId).toBe("agent-stable");
  });

  it("applies persisted runtime options before running turns", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey: "agent:codex:acp:session-1",
      storeSessionKey: "agent:codex:acp:session-1",
      acp: {
        ...readySessionMeta(),
        runtimeOptions: {
          runtimeMode: "plan",
          model: "openai-codex/gpt-5.4",
          thinking: "high",
          permissionProfile: "strict",
          timeoutSeconds: 120,
        },
      },
    });

    const manager = new AcpSessionManager();
    await manager.runTurn({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-1",
      text: "do work",
      mode: "prompt",
      requestId: "run-1",
    });

    expectMockCallFields(runtimeState.setMode, {
      mode: "plan",
    });
    expectMockCallFields(runtimeState.setConfigOption, {
      key: "model",
      value: "openai-codex/gpt-5.4",
    });
    expectMockCallFields(runtimeState.setConfigOption, {
      key: "thinking",
      value: "high",
    });
    expectMockCallFields(runtimeState.setConfigOption, {
      key: "approval_policy",
      value: "strict",
    });
    expectMockCallFields(runtimeState.setConfigOption, {
      key: "timeout",
      value: "120",
    });
  });

  it("maps persisted thinking runtime options to advertised effort config keys before running turns", async () => {
    const runtimeState = createRuntime();
    runtimeState.getCapabilities.mockResolvedValue({
      controls: ["session/set_mode", "session/set_config_option", "session/status"],
      configOptionKeys: ["mode", "model", "effort"],
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey: "agent:claude:acp:session-1",
      storeSessionKey: "agent:claude:acp:session-1",
      acp: {
        ...readySessionMeta({ agent: "claude" }),
        runtimeOptions: {
          thinking: "high",
        },
      },
    });

    const manager = new AcpSessionManager();
    await manager.runTurn({
      cfg: baseCfg,
      sessionKey: "agent:claude:acp:session-1",
      text: "do work",
      mode: "prompt",
      requestId: "run-1",
    });

    expectMockCallFields(runtimeState.setConfigOption, {
      key: "effort",
      value: "high",
    });
    expectNoMockCallFields(runtimeState.setConfigOption, {
      key: "thinking",
    });
  });

  it("maps persisted runtime options to backend-advertised aliases before running turns", async () => {
    const runtimeState = createRuntime();
    runtimeState.getCapabilities.mockResolvedValue({
      controls: ["session/set_config_option", "session/status"],
      configOptionKeys: ["model", "thought_level", "permissions", "timeout_seconds"],
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey: "agent:gemini:acp:session-1",
      storeSessionKey: "agent:gemini:acp:session-1",
      acp: {
        ...readySessionMeta({ agent: "gemini" }),
        runtimeOptions: {
          model: "gemini-3-flash-preview",
          thinking: "high",
          permissionProfile: "strict",
          timeoutSeconds: 120,
        },
      },
    });

    const manager = new AcpSessionManager();
    await manager.runTurn({
      cfg: baseCfg,
      sessionKey: "agent:gemini:acp:session-1",
      text: "do work",
      mode: "prompt",
      requestId: "run-1",
    });

    expectMockCallFields(runtimeState.setConfigOption, {
      key: "thought_level",
      value: "high",
    });
    expectMockCallFields(runtimeState.setConfigOption, {
      key: "permissions",
      value: "strict",
    });
    expectMockCallFields(runtimeState.setConfigOption, {
      key: "timeout_seconds",
      value: "120",
    });
    expectNoMockCallFields(runtimeState.setConfigOption, {
      key: "thinking",
    });
    expectNoMockCallFields(runtimeState.setConfigOption, {
      key: "approval_policy",
    });
    expectNoMockCallFields(runtimeState.setConfigOption, {
      key: "timeout",
    });
  });

  it("re-ensures runtime handles after cwd runtime option updates", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    const sessionKey = "agent:codex:acp:session-cwd-update";
    let currentEntry = {
      sessionKey,
      storeSessionKey: sessionKey,
      acp: readySessionMeta(),
    };
    hoisted.readAcpSessionEntryMock.mockImplementation(() => currentEntry);
    hoisted.upsertAcpSessionMetaMock.mockImplementation((paramsUnknown: unknown) => {
      const params = paramsUnknown as {
        mutate: (
          current: SessionAcpMeta | undefined,
          entry: { acp?: SessionAcpMeta } | undefined,
        ) => SessionAcpMeta | null | undefined;
      };
      const nextMeta = params.mutate(currentEntry.acp, currentEntry);
      if (nextMeta === null) {
        return null;
      }
      currentEntry = {
        ...currentEntry,
        acp: nextMeta ?? currentEntry.acp,
      };
      return currentEntry;
    });

    const manager = new AcpSessionManager();
    await manager.runTurn({
      cfg: baseCfg,
      sessionKey,
      text: "first",
      mode: "prompt",
      requestId: "r1",
    });

    await expect(
      manager.updateSessionRuntimeOptions({
        cfg: baseCfg,
        sessionKey,
        patch: { cwd: "/workspace/next" },
      }),
    ).resolves.toEqual({
      cwd: "/workspace/next",
    });

    expect(currentEntry.acp.runtimeOptions).toEqual({
      cwd: "/workspace/next",
    });
    expect(currentEntry.acp.cwd).toBe("/workspace/next");

    await manager.runTurn({
      cfg: baseCfg,
      sessionKey,
      text: "second",
      mode: "prompt",
      requestId: "r2",
    });

    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(2);
    expectRecordFields(mockCallArg(runtimeState.ensureSession, 1), {
      sessionKey,
      cwd: "/workspace/next",
    });
  });

  it("returns unsupported-control error when backend does not support set_config_option", async () => {
    const runtimeState = createRuntime();
    const unsupportedRuntime: AcpRuntime = {
      ensureSession: runtimeState.ensureSession as AcpRuntime["ensureSession"],
      runTurn: runtimeState.runTurn as AcpRuntime["runTurn"],
      getCapabilities: vi.fn(async () => ({ controls: [] })),
      cancel: runtimeState.cancel as AcpRuntime["cancel"],
      close: runtimeState.close as AcpRuntime["close"],
    };
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: unsupportedRuntime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey: "agent:codex:acp:session-1",
      storeSessionKey: "agent:codex:acp:session-1",
      acp: readySessionMeta(),
    });

    const manager = new AcpSessionManager();
    await expectRejectedRecord(
      manager.setSessionConfigOption({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:session-1",
        key: "model",
        value: "gpt-5.4",
      }),
      { code: "ACP_BACKEND_UNSUPPORTED_CONTROL" },
    );
  });

  it("maps explicit thinking config updates to advertised effort keys", async () => {
    const runtimeState = createRuntime();
    runtimeState.getCapabilities.mockResolvedValue({
      controls: ["session/set_config_option", "session/status"],
      configOptionKeys: ["effort"],
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey: "agent:claude:acp:session-1",
      storeSessionKey: "agent:claude:acp:session-1",
      acp: readySessionMeta({ agent: "claude" }),
    });

    const manager = new AcpSessionManager();
    const nextOptions = await manager.setSessionConfigOption({
      cfg: baseCfg,
      sessionKey: "agent:claude:acp:session-1",
      key: "thinking",
      value: "high",
    });

    expectMockCallFields(runtimeState.setConfigOption, {
      key: "effort",
      value: "high",
    });
    expect(nextOptions).toEqual({ thinking: "high" });
  });

  it("maps thinking config updates using status config options when capabilities omit keys", async () => {
    const runtimeState = createRuntime();
    runtimeState.getCapabilities.mockResolvedValue({
      controls: ["session/set_config_option", "session/status"],
    });
    runtimeState.getStatus.mockResolvedValue({
      summary: "status=alive",
      details: {
        configOptions: [{ id: "mode" }, { id: "model" }, { id: "effort" }],
      },
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey: "agent:claude:acp:session-1",
      storeSessionKey: "agent:claude:acp:session-1",
      acp: readySessionMeta({ agent: "claude" }),
    });

    const manager = new AcpSessionManager();
    const nextOptions = await manager.setSessionConfigOption({
      cfg: baseCfg,
      sessionKey: "agent:claude:acp:session-1",
      key: "thinking",
      value: "high",
    });

    expect(runtimeState.getStatus).toHaveBeenCalled();
    expectMockCallFields(runtimeState.setConfigOption, {
      key: "effort",
      value: "high",
    });
    expect(nextOptions).toEqual({ thinking: "high" });
  });

  it("persists explicit native effort config updates as canonical thinking options", async () => {
    const runtimeState = createRuntime();
    runtimeState.getCapabilities.mockResolvedValue({
      controls: ["session/set_config_option", "session/status"],
      configOptionKeys: ["effort"],
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey: "agent:claude:acp:session-1",
      storeSessionKey: "agent:claude:acp:session-1",
      acp: readySessionMeta({ agent: "claude" }),
    });

    const manager = new AcpSessionManager();
    const nextOptions = await manager.setSessionConfigOption({
      cfg: baseCfg,
      sessionKey: "agent:claude:acp:session-1",
      key: "effort",
      value: "high",
    });

    expectMockCallFields(runtimeState.setConfigOption, {
      key: "effort",
      value: "high",
    });
    expect(nextOptions).toEqual({ thinking: "high" });
  });

  it("persists explicit native permission_mode config updates as canonical permission profiles", async () => {
    const runtimeState = createRuntime();
    runtimeState.getCapabilities.mockResolvedValue({
      controls: ["session/set_config_option", "session/status"],
      configOptionKeys: ["permission_mode"],
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey: "agent:claude:acp:session-1",
      storeSessionKey: "agent:claude:acp:session-1",
      acp: readySessionMeta({ agent: "claude" }),
    });

    const manager = new AcpSessionManager();
    const nextOptions = await manager.setSessionConfigOption({
      cfg: baseCfg,
      sessionKey: "agent:claude:acp:session-1",
      key: "permission_mode",
      value: "strict",
    });

    expectMockCallFields(runtimeState.setConfigOption, {
      key: "permission_mode",
      value: "strict",
    });
    expect(nextOptions).toEqual({ permissionProfile: "strict" });
  });

  it("rejects invalid runtime option values before backend controls run", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey: "agent:codex:acp:session-1",
      storeSessionKey: "agent:codex:acp:session-1",
      acp: readySessionMeta(),
    });

    const manager = new AcpSessionManager();
    await expectRejectedRecord(
      manager.setSessionConfigOption({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:session-1",
        key: "timeout",
        value: "not-a-number",
      }),
      { code: "ACP_INVALID_RUNTIME_OPTION" },
    );
    expect(runtimeState.setConfigOption).not.toHaveBeenCalled();

    await expectRejectedRecord(
      manager.updateSessionRuntimeOptions({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:session-1",
        patch: { cwd: "relative/path" },
      }),
      { code: "ACP_INVALID_RUNTIME_OPTION" },
    );
  });

  it("can close and clear metadata when backend is unavailable", async () => {
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey: "agent:codex:acp:session-1",
      storeSessionKey: "agent:codex:acp:session-1",
      acp: readySessionMeta(),
    });
    hoisted.requireAcpRuntimeBackendMock.mockImplementation(() => {
      throw new AcpRuntimeError(
        "ACP_BACKEND_MISSING",
        "ACP runtime backend is not configured. Install and enable the acpx runtime plugin.",
      );
    });

    const manager = new AcpSessionManager();
    const result = await manager.closeSession({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-1",
      reason: "manual-close",
      allowBackendUnavailable: true,
      clearMeta: true,
    });

    expect(result.runtimeClosed).toBe(false);
    expect(result.runtimeNotice).toContain("not configured");
    expect(result.metaCleared).toBe(true);
    expect(hoisted.upsertAcpSessionMetaMock).toHaveBeenCalled();
  });

  it("does not fail reset close recovery when backend lookup also throws", async () => {
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey: "agent:codex:acp:session-1",
      storeSessionKey: "agent:codex:acp:session-1",
      acp: readySessionMeta(),
    });
    hoisted.requireAcpRuntimeBackendMock.mockImplementation(() => {
      throw new AcpRuntimeError(
        "ACP_BACKEND_MISSING",
        "ACP runtime backend is not configured. Install and enable the acpx runtime plugin.",
      );
    });

    const manager = new AcpSessionManager();
    const result = await manager.closeSession({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-1",
      reason: "new-in-place-reset",
      discardPersistentState: true,
      allowBackendUnavailable: true,
      clearMeta: false,
    });

    expect(result.runtimeClosed).toBe(false);
    expect(result.runtimeNotice).toContain("not configured");
    expect(result.metaCleared).toBe(false);
  });

  it("prepares a fresh session during reset recovery even when the backend is unhealthy", async () => {
    const runtimeState = createRuntime();
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey: "agent:claude:acp:session-1",
      storeSessionKey: "agent:claude:acp:session-1",
      acp: readySessionMeta({
        agent: "claude",
      }),
    });
    hoisted.requireAcpRuntimeBackendMock.mockImplementation(() => {
      throw new AcpRuntimeError(
        "ACP_BACKEND_UNAVAILABLE",
        "ACP runtime backend is currently unavailable. Try again in a moment.",
      );
    });
    hoisted.getAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });

    const manager = new AcpSessionManager();
    const result = await manager.closeSession({
      cfg: baseCfg,
      sessionKey: "agent:claude:acp:session-1",
      reason: "new-in-place-reset",
      discardPersistentState: true,
      allowBackendUnavailable: true,
      clearMeta: false,
    });

    expect(result.runtimeClosed).toBe(false);
    expect(result.runtimeNotice).toContain("currently unavailable");
    expect(runtimeState.prepareFreshSession).toHaveBeenCalledWith({
      sessionKey: "agent:claude:acp:session-1",
    });
  });

  it("surfaces metadata clear errors during closeSession", async () => {
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey: "agent:codex:acp:session-1",
      storeSessionKey: "agent:codex:acp:session-1",
      acp: readySessionMeta(),
    });
    hoisted.requireAcpRuntimeBackendMock.mockImplementation(() => {
      throw new AcpRuntimeError(
        "ACP_BACKEND_MISSING",
        "ACP runtime backend is not configured. Install and enable the acpx runtime plugin.",
      );
    });
    hoisted.upsertAcpSessionMetaMock.mockRejectedValueOnce(new Error("disk locked"));

    const manager = new AcpSessionManager();
    await expect(
      manager.closeSession({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:session-1",
        reason: "manual-close",
        allowBackendUnavailable: true,
        clearMeta: true,
      }),
    ).rejects.toThrow("disk locked");
  });
});
