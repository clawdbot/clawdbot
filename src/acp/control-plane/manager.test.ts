/** Tests ACP session manager resolution, turn execution, state transitions, and cleanup. */
import { setTimeout as scheduleNativeTimeout } from "node:timers";
import { setTimeout as sleep } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it, vi } from "vitest";
import {
  requireTaskByRunId,
  withAcpManagerTaskStateDir,
} from "../../../test/helpers/acp-manager-task-state.js";
import { listSessionStateEventsSince } from "../../sessions/session-state-events.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { isAcpTurnActive } from "./active-turns.js";
import {
  AcpRuntimeError,
  AcpSessionManager,
  baseCfg,
  createDeferred,
  createRuntime,
  expectRecordFields,
  expectRejectedRecord,
  extractStateUpsertPersistenceOptions,
  extractStatesFromUpserts,
  flushMicrotasks,
  hoisted,
  installAcpSessionManagerTestLifecycle,
  mockCallArg,
  mockParentedAcpSessionEntries,
  readySessionMeta,
  type OpenClawConfig,
  resetAcpSessionManagerForTests,
  type SessionAcpMeta,
} from "./manager.test-helpers.js";

describe("AcpSessionManager", () => {
  installAcpSessionManagerTestLifecycle();

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
    expectRecordFields(mockCallArg(hoisted.readAcpSessionEntryMock), {
      clone: false,
      sessionKey: "agent:codex:acp:session-1",
    });
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
      provenance: "system",
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
    expect(extractStateUpsertPersistenceOptions()).toEqual([
      { state: "running", skipMaintenance: true, takeCacheOwnership: true },
      { state: "idle", skipMaintenance: true, takeCacheOwnership: true },
    ]);
  });

  it("records parented ACP turns only for human provenance", async () => {
    await withAcpManagerTaskStateDir(async () => {
      const runtimeState = createRuntime();
      hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
        id: "acpx",
        runtime: runtimeState.runtime,
      });
      const childSessionKey = "agent:main:acp:child-state";
      mockParentedAcpSessionEntries({
        childSessionKey,
        parentSessionKey: "agent:main:main",
      });
      const manager = new AcpSessionManager();

      await manager.runTurn({
        provenance: "human",
        cfg: baseCfg,
        sessionKey: childSessionKey,
        text: "human turn",
        mode: "prompt",
        requestId: "human-state-turn",
      });
      await manager.runTurn({
        provenance: "system",
        cfg: baseCfg,
        sessionKey: childSessionKey,
        text: "system turn",
        mode: "prompt",
        requestId: "system-state-turn",
      });
      runtimeState.runTurn.mockImplementationOnce(async function* () {
        yield { type: "done" as const, status: "cancelled" as const };
      });
      await manager.runTurn({
        provenance: "system",
        cfg: baseCfg,
        sessionKey: childSessionKey,
        text: "cancelled turn",
        mode: "prompt",
        requestId: "cancelled-state-turn",
      });

      expect(listSessionStateEventsSince(childSessionKey, "main", 0, 200).events).toMatchObject([
        { kind: "human_direct_message", runId: "human-state-turn" },
        { kind: "run_completed", runId: "human-state-turn" },
        { kind: "run_completed", runId: "system-state-turn" },
        {
          kind: "run_failed",
          runId: "cancelled-state-turn",
          summary: "child run cancelled",
          payload: { outcome: "cancelled" },
        },
      ]);
      closeOpenClawStateDatabaseForTest();
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
        provenance: "system",
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
        provenance: "system",
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
      provenance: "system",
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
      provenance: "system",
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

  it("reports a live turn under the task record's childSessionKey while it is in flight (#88205)", async () => {
    await withAcpManagerTaskStateDir(async () => {
      const runtimeState = createRuntime();
      const releaseTurn = createDeferred();
      runtimeState.runTurn.mockImplementation(async function* () {
        await releaseTurn.promise;
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
              label: "Live turn",
            },
            acp: readySessionMeta(),
          };
        }
        if (sessionKey === "agent:quant:telegram:quant:direct:822430204") {
          return {
            sessionKey,
            storeSessionKey: sessionKey,
            entry: { sessionId: "parent-1", updatedAt: Date.now() },
          };
        }
        return null;
      });

      const manager = new AcpSessionManager();
      const turn = manager.runTurn({
        provenance: "system",
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:child-1",
        text: "long running",
        mode: "prompt",
        requestId: "live-acp-turn",
      });
      await vi.waitFor(
        () => {
          expect(runtimeState.runTurn).toHaveBeenCalledTimes(1);
        },
        { interval: 1 },
      );

      // The maintenance sweep probes liveness with exactly this key; prove it resolves to the
      // turn the manager actually registered, so the reclaim gate cannot over-reclaim a live run.
      const childSessionKey = requireTaskByRunId("live-acp-turn").childSessionKey;
      if (!childSessionKey) {
        throw new Error("Expected the ACP task record to carry a childSessionKey");
      }
      expect(childSessionKey).toBe("agent:codex:acp:child-1");
      expect(isAcpTurnActive(childSessionKey)).toBe(true);

      releaseTurn.resolve();
      await turn;
      await flushMicrotasks();

      expect(isAcpTurnActive(childSessionKey)).toBe(false);
    });
  }, 300_000);

  it("marks liveness during runtime initialization, before the turn streams (#88205)", async () => {
    await withAcpManagerTaskStateDir(async () => {
      const runtimeState = createRuntime();
      const releaseInit = createDeferred();
      // Hold runtime init (ensureSession) so the turn is stuck initializing: the task record
      // already exists but the turn stream has not started. This is the window that previously
      // let the authoritative sweep mark a live, slow-to-initialize ACP task as lost.
      runtimeState.ensureSession.mockImplementation(
        async (input: { sessionKey: string; mode: "persistent" | "oneshot" }) => {
          await releaseInit.promise;
          return {
            sessionKey: input.sessionKey,
            backend: "acpx",
            runtimeSessionName: `${input.sessionKey}:${input.mode}:runtime`,
          };
        },
      );
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
              label: "Init window",
            },
            acp: readySessionMeta(),
          };
        }
        if (sessionKey === "agent:quant:telegram:quant:direct:822430204") {
          return {
            sessionKey,
            storeSessionKey: sessionKey,
            entry: { sessionId: "parent-1", updatedAt: Date.now() },
          };
        }
        return null;
      });

      const manager = new AcpSessionManager();
      const turn = manager.runTurn({
        provenance: "system",
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:child-1",
        text: "slow init",
        mode: "prompt",
        requestId: "init-window-acp-turn",
      });
      await vi.waitFor(
        () => {
          expect(runtimeState.ensureSession).toHaveBeenCalled();
        },
        { interval: 1 },
      );

      const childSessionKey = requireTaskByRunId("init-window-acp-turn").childSessionKey;
      if (!childSessionKey) {
        throw new Error("Expected the ACP task record to carry a childSessionKey");
      }
      // Liveness must already cover initialization, while the turn stream has not started.
      expect(runtimeState.runTurn).not.toHaveBeenCalled();
      expect(isAcpTurnActive(childSessionKey)).toBe(true);

      releaseInit.resolve();
      await turn;
      await flushMicrotasks();

      expect(isAcpTurnActive(childSessionKey)).toBe(false);
    });
  }, 300_000);

  it("clears liveness when retry setup throws before task terminal update (#88205)", async () => {
    await withAcpManagerTaskStateDir(async () => {
      const runtimeState = createRuntime();
      runtimeState.runTurn.mockImplementationOnce(async function* () {
        yield { type: "error" as const, message: "acpx exited with code 1" };
      });
      hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
        id: "acpx",
        runtime: runtimeState.runtime,
      });
      let childReads = 0;
      hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
        const sessionKey = (paramsUnknown as { sessionKey?: string }).sessionKey;
        if (sessionKey === "agent:codex:acp:child-1") {
          childReads += 1;
          if (childReads > 2) {
            throw new Error("session store unavailable");
          }
          return {
            sessionKey,
            storeSessionKey: sessionKey,
            entry: {
              sessionId: "child-1",
              updatedAt: Date.now(),
              spawnedBy: "agent:quant:telegram:quant:direct:822430204",
              label: "Retry cleanup",
            },
            acp: readySessionMeta(),
          };
        }
        if (sessionKey === "agent:quant:telegram:quant:direct:822430204") {
          return {
            sessionKey,
            storeSessionKey: sessionKey,
            entry: { sessionId: "parent-1", updatedAt: Date.now() },
          };
        }
        return null;
      });

      const manager = new AcpSessionManager();
      await expect(
        manager.runTurn({
          provenance: "system",
          cfg: baseCfg,
          sessionKey: "agent:codex:acp:child-1",
          text: "stale resume",
          mode: "prompt",
          requestId: "retry-cleanup-failure-acp-turn",
        }),
      ).rejects.toThrow("session store unavailable");

      const childSessionKey = requireTaskByRunId("retry-cleanup-failure-acp-turn").childSessionKey;
      if (!childSessionKey) {
        throw new Error("Expected the ACP task record to carry a childSessionKey");
      }
      expect(isAcpTurnActive(childSessionKey)).toBe(false);
    });
  }, 300_000);

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
      provenance: "system",
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
      provenance: "system",
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
        (error: unknown) => ({ status: "rejected" as const, error }),
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

  it("times out a hung persistent turn after partial progress without closing the session and lets queued work continue", async () => {
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
          yield { type: "text_delta" as const, text: "Working on it..." };
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
        provenance: "system",
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
        provenance: "system",
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

  it("caps ACP runtime option turn timeouts before arming the watchdog", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey: "agent:codex:acp:session-1",
      storeSessionKey: "agent:codex:acp:session-1",
      acp: readySessionMeta({
        runtimeOptions: {
          timeoutSeconds: Number.MAX_SAFE_INTEGER,
        },
      }),
    });
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const manager = new AcpSessionManager();
      await manager.runTurn({
        provenance: "system",
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:session-1",
        text: "first",
        mode: "prompt",
        requestId: "r1",
      });

      expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
    } finally {
      timeoutSpy.mockRestore();
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
        provenance: "system",
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
          provenance: "system",
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
          provenance: "system",
          cfg: baseCfg,
          sessionKey: "agent:codex:acp:session-a",
          text: "first",
          mode: "prompt",
          requestId: "r1",
        }),
        manager.runTurn({
          provenance: "system",
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
      provenance: "system",
      cfg: limitedCfg,
      sessionKey: "agent:codex:acp:session-a",
      text: "first",
      mode: "prompt",
      requestId: "r1",
    });

    await expectRejectedRecord(
      manager.runTurn({
        provenance: "system",
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

  it("uses metadata backend when global acp.backend is unset", async () => {
    const runtimeState = createRuntime();
    runtimeState.ensureSession.mockImplementation(async (input) => ({
      sessionKey: input.sessionKey,
      backend: "metadata-backend",
      runtimeSessionName: "metadata-runtime",
    }));
    hoisted.requireAcpRuntimeBackendMock.mockImplementation((backendId?: string) => {
      if (backendId !== "metadata-backend") {
        throw new Error(`unexpected backend ${backendId ?? "<auto>"}`);
      }
      return {
        id: "metadata-backend",
        runtime: runtimeState.runtime,
      };
    });
    const sessionKey = "agent:codex:acp:session-1";
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey,
      storeSessionKey: sessionKey,
      acp: readySessionMeta({
        backend: "metadata-backend",
        runtimeSessionName: "metadata-runtime",
      }),
    });
    const cfg = {
      acp: {
        enabled: true,
        dispatch: { enabled: true },
      },
    } as OpenClawConfig;

    const manager = new AcpSessionManager();
    await expect(
      manager.runTurn({
        provenance: "system",
        cfg,
        sessionKey,
        text: "hello",
        mode: "prompt",
        requestId: "r-metadata",
      }),
    ).resolves.toBeUndefined();

    expect(hoisted.requireAcpRuntimeBackendMock).toHaveBeenCalledWith("metadata-backend");
    expect(runtimeState.runTurn).toHaveBeenCalledTimes(1);
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
        provenance: "system",
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
          provenance: "system",
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
        provenance: "system",
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
      expectDefined(
        runtimeState.ensureSession.mock.invocationCallOrder[0],
        "runtimeState.ensureSession.mock.invocationCallOrder[0] test invariant",
      ),
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
        provenance: "system",
        cfg,
        sessionKey: "agent:codex:acp:session-a",
        text: "first",
        mode: "prompt",
        requestId: "r1",
      });

      vi.advanceTimersByTime(2_000);
      await manager.runTurn({
        provenance: "system",
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
      provenance: "system",
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-1",
      text: "ok",
      mode: "prompt",
      requestId: "ok",
    });
    await expectRejectedRecord(
      manager.runTurn({
        provenance: "system",
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
        provenance: "system",
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
