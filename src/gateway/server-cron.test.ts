// Gateway cron tests cover isolated agent turns, heartbeat wakeups, completion
// delivery, lifecycle cleanup, hook emission, and SSRF-guarded webhooks.
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentDeletionCommitUncertainError } from "../agents/agent-lifecycle-registry.js";
import type { CliDeps } from "../cli/deps.js";
import type { OpenClawConfig } from "../config/config.js";
import { SsrFBlockedError } from "../infra/net/ssrf.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import { createDeferred } from "../test-utils/deferred.js";

type RunCronIsolatedAgentTurnMock = (params: {
  abortSignal?: AbortSignal;
}) => Promise<{ status: "ok"; summary: string }>;

const {
  enqueueSystemEventMock,
  consumeSelectedSystemEventEntriesMock,
  requestHeartbeatMock,
  runHeartbeatOnceMock,
  loadConfigMock,
  fetchWithSsrFGuardMock,
  sendCronAnnouncePayloadStrictMock,
  runCronIsolatedAgentTurnMock,
  cleanupBrowserSessionsForLifecycleEndMock,
  getGlobalHookRunnerMock,
  runCronChangedMock,
  abortAndDrainEmbeddedAgentRunMock,
  retireSessionMcpRuntimeMock,
  requestSafeGatewayRestartMock,
  getProcessSupervisorMock,
  createCronScriptRuntimeMock,
  cronTriggerEvaluatorMock,
  cronScriptExecutorMock,
  isAgentDeletionBlockedMock,
} = vi.hoisted(() => ({
  enqueueSystemEventMock: vi.fn(),
  consumeSelectedSystemEventEntriesMock: vi.fn((_sessionKey, entries) => entries ?? []),
  requestHeartbeatMock: vi.fn(),
  runHeartbeatOnceMock: vi.fn<
    (...args: unknown[]) => Promise<{ status: "ran"; durationMs: number }>
  >(async () => ({ status: "ran", durationMs: 1 })),
  loadConfigMock: vi.fn(),
  fetchWithSsrFGuardMock: vi.fn(),
  sendCronAnnouncePayloadStrictMock: vi.fn(async () => {}),
  runCronIsolatedAgentTurnMock: vi.fn<RunCronIsolatedAgentTurnMock>(async () => ({
    status: "ok",
    summary: "ok",
  })),
  cleanupBrowserSessionsForLifecycleEndMock: vi.fn(async () => {}),
  runCronChangedMock: vi.fn(async (_event: unknown, _context?: unknown) => {}),
  getGlobalHookRunnerMock: vi.fn(() => ({
    hasHooks: (hookName: string) => hookName === "cron_changed",
    runCronChanged: runCronChangedMock,
  })),
  abortAndDrainEmbeddedAgentRunMock: vi.fn(async () => ({
    aborted: true,
    drained: true,
    forceCleared: false,
  })),
  retireSessionMcpRuntimeMock: vi.fn(async () => true),
  requestSafeGatewayRestartMock: vi.fn(() => ({
    ok: true,
    status: "scheduled",
    preflight: {
      safe: true,
      counts: {
        queueSize: 0,
        pendingReplies: 0,
        embeddedRuns: 0,
        activeTasks: 0,
        totalActive: 0,
      },
      blockers: [],
      summary: "safe to restart now",
    },
    restart: {
      ok: true,
      pid: 123,
      signal: "SIGUSR1",
      delayMs: 0,
      reason: "cron.isolated_agent_setup_timeout",
      mode: "emit",
      coalesced: false,
      cooldownMsApplied: 0,
    },
  })),
  getProcessSupervisorMock: vi.fn(() => ({
    spawn: vi.fn(),
    cancelScope: vi.fn(),
  })),
  createCronScriptRuntimeMock: vi.fn(),
  cronTriggerEvaluatorMock: vi.fn(),
  cronScriptExecutorMock: vi.fn(),
  isAgentDeletionBlockedMock: vi.fn((_agentId: string) => false),
}));

function enqueueSystemEvent(text: string, opts?: unknown) {
  return enqueueSystemEventMock(text, opts);
}

function enqueueSystemEventEntry(text: string, opts?: unknown) {
  const result = enqueueSystemEventMock(text, opts);
  if (result === false || result === null) {
    return null;
  }
  return {
    text,
    ts: Date.now(),
  };
}

function consumeSelectedSystemEventEntries(sessionKey: string, entries: readonly unknown[]) {
  return consumeSelectedSystemEventEntriesMock(sessionKey, entries);
}

function requestHeartbeat(...args: unknown[]) {
  return requestHeartbeatMock(...args);
}

function runHeartbeatOnce(...args: unknown[]) {
  return runHeartbeatOnceMock(...args);
}

vi.mock("../infra/system-events.js", () => ({
  enqueueSystemEvent,
  enqueueSystemEventEntry,
  consumeSelectedSystemEventEntries,
}));

vi.mock("../infra/heartbeat-wake.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/heartbeat-wake.js")>(
    "../infra/heartbeat-wake.js",
  );
  return {
    ...actual,
    requestHeartbeat,
  };
});

vi.mock("../infra/heartbeat-runner.js", () => ({
  runHeartbeatOnce,
}));

vi.mock("../infra/restart-coordinator.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/restart-coordinator.js")>(
    "../infra/restart-coordinator.js",
  );
  return {
    ...actual,
    requestSafeGatewayRestart: requestSafeGatewayRestartMock,
  };
});

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    getRuntimeConfig: () => loadConfigMock(),
  };
});

vi.mock("../config/io.js", async () => {
  const actual = await vi.importActual<typeof import("../config/io.js")>("../config/io.js");
  return {
    ...actual,
    getRuntimeConfig: () => loadConfigMock(),
  };
});

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

vi.mock("../cron/delivery.js", async () => {
  const actual = await vi.importActual<typeof import("../cron/delivery.js")>("../cron/delivery.js");
  return {
    ...actual,
    sendCronAnnouncePayloadStrict: sendCronAnnouncePayloadStrictMock,
  };
});

vi.mock("../cron/isolated-agent.js", () => ({
  runCronIsolatedAgentTurn: runCronIsolatedAgentTurnMock,
}));

vi.mock("../browser-lifecycle-cleanup.js", () => ({
  cleanupBrowserSessionsForLifecycleEnd: cleanupBrowserSessionsForLifecycleEndMock,
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: getGlobalHookRunnerMock,
}));

vi.mock("../agents/embedded-agent.js", () => ({
  abortAndDrainEmbeddedAgentRun: abortAndDrainEmbeddedAgentRunMock,
}));

vi.mock("../agents/agent-bundle-mcp-tools.js", () => ({
  retireSessionMcpRuntime: retireSessionMcpRuntimeMock,
}));

vi.mock("../agents/agent-lifecycle-registry.js", () => ({
  AgentDeletionAuthorityRollbackError: class extends AggregateError {},
  AgentDeletionCommitUncertainError: class extends Error {},
  isAgentDeletionBlocked: isAgentDeletionBlockedMock,
}));

vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: getProcessSupervisorMock,
}));

vi.mock("../cron/trigger-script.js", () => ({
  createCronScriptRuntime: createCronScriptRuntimeMock,
}));

import type { CronJob } from "../cron/types.js";
import { buildGatewayCronService, fireOnExitJob } from "./server-cron.js";

function createCronConfig(name: string): OpenClawConfig {
  const tmpDir = path.join(os.tmpdir(), `${name}-${Date.now()}`);
  return {
    session: {
      mainKey: "main",
    },
    cron: {
      store: path.join(tmpDir, "cron.json"),
    },
  } as OpenClawConfig;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error(`expected ${label}`);
  }
  return value as Record<string, unknown>;
}

function callArg(
  mock: { mock: { calls: Array<Array<unknown>> } },
  callIndex: number,
  argIndex: number,
  label: string,
) {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected mock call: ${label}`);
  }
  if (argIndex >= call.length) {
    throw new Error(`Expected mock call argument ${argIndex}: ${label}`);
  }
  return call[argIndex];
}

function expectMainCronRunSessionKey(value: unknown, jobId: string) {
  expect(value).toMatch(new RegExp(`^agent:main:cron:${jobId}:run:\\d+$`));
}

function lastMockCall(mock: { mock: { calls: Array<Array<unknown>> } }, label: string) {
  const calls = mock.mock.calls;
  const call = calls[calls.length - 1];
  if (!call) {
    throw new Error(`Expected last mock call: ${label}`);
  }
  return call;
}

function expectHookContext(callIndex: number, fields: { config?: unknown; hasGetCron?: boolean }) {
  const context = requireRecord(
    callArg(runCronChangedMock, callIndex, 1, "cron_changed context"),
    "cron_changed context",
  );
  if ("config" in fields) {
    expect(context.config).toBe(fields.config);
  }
  if (fields.hasGetCron === true) {
    expect(context.getCron).toBeTypeOf("function");
  }
}

function expectIsolatedRunFields(fields: Record<string, unknown>) {
  const options = requireRecord(
    callArg(runCronIsolatedAgentTurnMock, 0, 0, "isolated cron run"),
    "isolated cron run",
  );
  for (const [key, value] of Object.entries(fields)) {
    expect(options[key]).toEqual(value);
  }
  return options;
}

function expectCleanupForSessionKeys(sessionKeys: string[]) {
  expect(cleanupBrowserSessionsForLifecycleEndMock).toHaveBeenCalledTimes(1);
  const options = requireRecord(
    callArg(cleanupBrowserSessionsForLifecycleEndMock, 0, 0, "cleanup options"),
    "cleanup options",
  );
  expect(options.sessionKeys).toEqual(sessionKeys);
  expect(options.onWarn).toBeTypeOf("function");
}

describe("buildGatewayCronService", () => {
  beforeEach(() => {
    enqueueSystemEventMock.mockClear();
    consumeSelectedSystemEventEntriesMock.mockClear();
    requestHeartbeatMock.mockClear();
    runHeartbeatOnceMock.mockClear();
    loadConfigMock.mockClear();
    fetchWithSsrFGuardMock.mockClear();
    sendCronAnnouncePayloadStrictMock.mockClear();
    runCronIsolatedAgentTurnMock.mockClear();
    cleanupBrowserSessionsForLifecycleEndMock.mockClear();
    runCronChangedMock.mockClear();
    getGlobalHookRunnerMock.mockClear();
    abortAndDrainEmbeddedAgentRunMock.mockClear();
    retireSessionMcpRuntimeMock.mockClear();
    requestSafeGatewayRestartMock.mockClear();
    getProcessSupervisorMock.mockReset();
    getProcessSupervisorMock.mockReturnValue({
      spawn: vi.fn(),
      cancelScope: vi.fn(),
    });
    cronTriggerEvaluatorMock.mockReset();
    cronTriggerEvaluatorMock.mockResolvedValue({ kind: "evaluated", fire: false });
    cronScriptExecutorMock.mockReset();
    isAgentDeletionBlockedMock.mockReset().mockReturnValue(false);
    cronScriptExecutorMock.mockResolvedValue({ kind: "completed", stateChanged: false });
    createCronScriptRuntimeMock.mockReset();
    createCronScriptRuntimeMock.mockReturnValue({
      evaluateTrigger: cronTriggerEvaluatorMock,
      executePayload: cronScriptExecutorMock,
    });
    getGlobalHookRunnerMock.mockReturnValue({
      hasHooks: (hookName: string) => hookName === "cron_changed",
      runCronChanged: runCronChangedMock,
    });
  });

  it("passes the persisted payload tool cap to trigger evaluation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-14T12:00:00.000Z"));
    const cfg = createCronConfig("server-cron-trigger-tool-cap");
    cfg.cron = {
      ...cfg.cron,
      triggers: { enabled: true },
    };
    loadConfigMock.mockReturnValue(cfg);
    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });

    try {
      const job = await state.cron.add({
        name: "restricted trigger",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000, anchorMs: Date.now() },
        trigger: { script: "json({ fire: false })" },
        sessionTarget: "main",
        wakeMode: "now",
        payload: {
          kind: "systemEvent",
          text: "wake",
          toolsAllow: ["read", "cron"],
        },
      });
      vi.setSystemTime(job.state.nextRunAtMs ?? 0);

      expect(await state.cron.run(job.id, "due")).toEqual({ ok: true, ran: true });
      expect(cronTriggerEvaluatorMock).toHaveBeenCalledWith(
        expect.objectContaining({
          jobId: job.id,
          toolsAllow: ["read", "cron"],
        }),
      );
    } finally {
      state.cron.stop();
      vi.useRealTimers();
    }
  });

  it("stops on-exit watcher children when the direct cron service stops", async () => {
    vi.stubEnv("OPENCLAW_SKIP_CRON", "0");
    const cancelRun = vi.fn();
    const cancelScope = vi.fn();
    const spawn = vi.fn(async () => ({
      runId: "run-on-exit",
      startedAtMs: 0,
      wait: () => new Promise(() => {}),
      cancel: cancelRun,
    }));
    getProcessSupervisorMock.mockReturnValue({ spawn, cancelScope });
    const cfg = createCronConfig("server-cron-stop-exit-watchers");
    loadConfigMock.mockReturnValue(cfg);
    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });

    const job = await state.cron.add({
      name: "watch build",
      enabled: true,
      schedule: { kind: "on-exit", command: "sleep 60" },
      payload: { kind: "systemEvent", text: "done" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
    });
    await state.reconcileExitWatchers?.();

    try {
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
      state.cron.stop();
      expect(cancelRun).toHaveBeenCalledWith("manual-cancel");
      expect(cancelScope).toHaveBeenCalledWith(`cron-exit:${job.id}`, "manual-cancel");
    } finally {
      state.cron.stop();
      vi.unstubAllEnvs();
    }
  });

  it("backs off isolated cron setup timeout without gateway restart", async () => {
    vi.useFakeTimers();
    const runnerEntered = createDeferred();
    const cfg = createCronConfig("server-cron-isolated-setup-timeout");
    loadConfigMock.mockReturnValue(cfg);
    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const job = await state.cron.add({
        name: "isolated setup timeout",
        enabled: true,
        schedule: { kind: "at", at: new Date(Date.now()).toISOString() },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "work", timeoutSeconds: 120 },
      });
      runCronIsolatedAgentTurnMock.mockImplementationOnce(
        async ({ abortSignal }: { abortSignal?: AbortSignal }) => {
          abortSignal?.addEventListener("abort", () => undefined, { once: true });
          runnerEntered.resolve();
          return await new Promise<never>(() => {});
        },
      );

      const runPromise = state.cron.run(job.id, "force");
      await runnerEntered.promise;
      await vi.advanceTimersByTimeAsync(60_100);
      const runResult = await runPromise;

      expect(runResult).toEqual({ ok: true, ran: true });
      expect(requestSafeGatewayRestartMock).not.toHaveBeenCalled();
    } finally {
      state.cron.stop();
      vi.useRealTimers();
    }
  });

  it("emits cron_changed hooks with computed next run state", async () => {
    const cfg = createCronConfig("server-cron-hook");
    loadConfigMock.mockReturnValue(cfg);

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const job = await state.cron.add({
        name: "scheduler-hook",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000, anchorMs: 1_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "sync external wake" },
      });

      const event = requireRecord(
        callArg(runCronChangedMock, 0, 0, "cron_changed event"),
        "cron_changed event",
      );
      expect(event.action).toBe("added");
      expect(event.jobId).toBe(job.id);
      expect(event.sessionTarget).toBe("main");
      const eventJob = requireRecord(event.job, "cron_changed job");
      expect(eventJob.id).toBe(job.id);
      expect(eventJob.sessionTarget).toBe("main");
      expect(requireRecord(eventJob.state, "cron_changed job state").nextRunAtMs).toBe(
        job.state.nextRunAtMs,
      );
      expectHookContext(0, { config: cfg, hasGetCron: true });
    } finally {
      state.cron.stop();
    }
  });

  it("forwards durable recurring wake changes to cron_changed hooks", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T12:00:00.000Z"));
    const cfg = createCronConfig("server-cron-hook-scheduled");
    loadConfigMock.mockReturnValue(cfg);
    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const job = await state.cron.add({
        name: "scheduled-hook",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000, anchorMs: Date.now() },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "advance external wake" },
      });
      const dueAtMs = job.state.nextRunAtMs;
      if (dueAtMs === undefined) {
        throw new Error("expected recurring job to have a next run");
      }

      runCronChangedMock.mockClear();
      vi.setSystemTime(dueAtMs);
      expect(await state.cron.run(job.id, "due")).toEqual({ ok: true, ran: true });

      const scheduledCallIndex = runCronChangedMock.mock.calls.findIndex(([candidate]) => {
        return requireRecord(candidate, "cron_changed event").action === "scheduled";
      });
      expect(scheduledCallIndex).toBeGreaterThanOrEqual(0);
      const event = requireRecord(
        callArg(runCronChangedMock, scheduledCallIndex, 0, "scheduled cron_changed event"),
        "scheduled cron_changed event",
      );
      const persistedNextRunAtMs = state.cron.getJob(job.id)?.state.nextRunAtMs;
      expect(persistedNextRunAtMs).toBeGreaterThan(dueAtMs);
      expect(event).toMatchObject({
        action: "scheduled",
        jobId: job.id,
        nextRunAtMs: persistedNextRunAtMs,
        sessionTarget: "main",
      });
      const eventJob = requireRecord(event.job, "scheduled cron_changed job");
      expect(requireRecord(eventJob.state, "scheduled cron_changed job state").nextRunAtMs).toBe(
        persistedNextRunAtMs,
      );
      expectHookContext(scheduledCallIndex, { config: cfg, hasGetCron: true });
    } finally {
      state.cron.stop();
      vi.useRealTimers();
    }
  });

  it("keeps detached cron_changed hooks root-admitted until they settle", async () => {
    resetGatewayWorkAdmission();
    const deferred = createDeferred();
    runCronChangedMock.mockImplementationOnce(async () => await deferred.promise);
    const cfg = createCronConfig("server-cron-hook-admission");
    loadConfigMock.mockReturnValue(cfg);
    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });

    try {
      await state.cron.add({
        name: "held hook",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "hello" },
      });
      await vi.waitFor(() => expect(runCronChangedMock).toHaveBeenCalledTimes(1));
      expect(getActiveGatewayRootWorkCount()).toBe(1);

      deferred.resolve();
      await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
    } finally {
      deferred.resolve();
      state.cron.stop();
      resetGatewayWorkAdmission();
    }
  });

  it("cron_changed removed events include the deleted job snapshot", async () => {
    const cfg = createCronConfig("server-cron-hook-removed");
    loadConfigMock.mockReturnValue(cfg);

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const job = await state.cron.add({
        name: "to-be-removed",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000, anchorMs: 1_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "will be removed" },
      });

      runCronChangedMock.mockClear();
      await state.cron.remove(job.id);

      const event = requireRecord(
        callArg(runCronChangedMock, 0, 0, "cron_changed event"),
        "cron_changed event",
      );
      expect(event.action).toBe("removed");
      expect(event.jobId).toBe(job.id);
      expect(event.sessionTarget).toBe("main");
      const eventJob = requireRecord(event.job, "cron_changed job");
      expect(eventJob.id).toBe(job.id);
      expect(eventJob.name).toBe("to-be-removed");
      expect(eventJob.sessionTarget).toBe("main");
      expectHookContext(0, { hasGetCron: true });
    } finally {
      state.cron.stop();
    }
  });

  it("cron_changed hook event includes agentId from the job", async () => {
    const cfg = createCronConfig("server-cron-hook-agentId");
    cfg.agents = { list: [{ id: "main", default: true }, { id: "yinze" }] };
    loadConfigMock.mockReturnValue(cfg);

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const job = await state.cron.add({
        name: "agent-scoped-job",
        enabled: true,
        agentId: "yinze",
        schedule: { kind: "every", everyMs: 60_000, anchorMs: 1_000 },
        sessionTarget: "session:project-alpha",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "agent check" },
      });

      const event = requireRecord(
        callArg(runCronChangedMock, 0, 0, "cron_changed event"),
        "cron_changed event",
      );
      expect(event.action).toBe("added");
      expect(event.jobId).toBe(job.id);
      expect(event.sessionTarget).toBe("session:project-alpha");
      expect(event.agentId).toBe("yinze");
      const eventJob = requireRecord(event.job, "cron_changed job");
      expect(eventJob.id).toBe(job.id);
      expect(eventJob.agentId).toBe("yinze");
      expect(eventJob.sessionTarget).toBe("session:project-alpha");
      expectHookContext(0, { config: cfg });
    } finally {
      state.cron.stop();
    }
  });

  it("cron_changed hook context uses runtime config from getRuntimeConfig()", async () => {
    const startupCfg = createCronConfig("server-cron-hook-runtime-cfg");
    const runtimeCfg = { ...startupCfg, _marker: "runtime" };
    loadConfigMock.mockReturnValue(runtimeCfg);

    const state = buildGatewayCronService({
      cfg: startupCfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      await state.cron.add({
        name: "runtime-cfg-check",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000, anchorMs: 1_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "cfg check" },
      });

      // The hook context should use getRuntimeConfig() (runtimeCfg), not startupCfg
      expect(runCronChangedMock).toHaveBeenCalledTimes(1);
      const calls = runCronChangedMock.mock.calls as unknown[][];
      const hookCtx = calls[0]?.[1] as { config?: unknown } | undefined;
      expect(hookCtx?.config).toBe(runtimeCfg);
      expect(hookCtx?.config).not.toBe(startupCfg);
    } finally {
      state.cron.stop();
    }
  });

  it("routes main-target jobs to the scoped session for enqueue + wake", async () => {
    const cfg = createCronConfig("server-cron");
    loadConfigMock.mockReturnValue(cfg);

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const job = await state.cron.add({
        name: "canonicalize-session-key",
        enabled: true,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        sessionKey: "discord:channel:ops",
        payload: { kind: "systemEvent", text: "hello" },
      });

      await state.cron.run(job.id, "force");

      expect(callArg(enqueueSystemEventMock, 0, 0, "system event text")).toBe("hello");
      const eventOptions = requireRecord(
        callArg(enqueueSystemEventMock, 0, 1, "system event options"),
        "options",
      );
      expectMainCronRunSessionKey(eventOptions.sessionKey, job.id);
      const heartbeatRequest = requireRecord(
        callArg(requestHeartbeatMock, 0, 0, "heartbeat request"),
        "request",
      );
      expectMainCronRunSessionKey(heartbeatRequest.sessionKey, job.id);
    } finally {
      state.cron.stop();
    }
  });

  it("suppresses command cron NO_REPLY output before announce delivery", async () => {
    const cfg = createCronConfig("server-cron-command-no-reply");
    loadConfigMock.mockReturnValue(cfg);

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const job = await state.cron.add({
        name: "silent-command",
        enabled: true,
        deleteAfterRun: false,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: {
          kind: "command",
          argv: [process.execPath, "-e", "process.stdout.write('NO_REPLY\\n')"],
        },
        delivery: {
          mode: "announce",
          channel: "telegram",
          to: "123",
        },
      });

      await state.cron.run(job.id, "force");

      expect(state.cron.getJob(job.id)?.state.lastRunStatus).toBe("ok");
      expect(state.cron.getJob(job.id)?.state.lastDeliveryError).toBeUndefined();
    } finally {
      state.cron.stop();
    }
  });

  it("keeps a successful command on cadence when default announce delivery has no channel", async () => {
    const cfg = createCronConfig("server-cron-command-delivery-failure");
    loadConfigMock.mockReturnValue(cfg);
    const deliveryError = "Channel is required (no configured channels detected)";
    sendCronAnnouncePayloadStrictMock.mockRejectedValueOnce(new Error(deliveryError));

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const job = await state.cron.add({
        name: "successful-headless-command",
        enabled: true,
        deleteAfterRun: false,
        schedule: { kind: "every", everyMs: 20_000, anchorMs: Date.now() },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: {
          kind: "command",
          argv: [process.execPath, "-e", "process.stdout.write('ok')"],
        },
      });
      const normalNextRunAtMs = job.state.nextRunAtMs;
      expect(job.delivery).toEqual({ mode: "announce" });

      await state.cron.run(job.id, "force");

      const updated = state.cron.getJob(job.id);
      expect(updated?.state.lastRunStatus).toBe("ok");
      expect(updated?.state.lastError).toBeUndefined();
      expect(updated?.state.consecutiveErrors ?? 0).toBe(0);
      expect(updated?.state.nextRunAtMs).toBe(normalNextRunAtMs);
      expect(updated?.state.lastDeliveryStatus).toBe("not-delivered");
      expect(updated?.state.lastDeliveryError).toBe(deliveryError);
    } finally {
      state.cron.stop();
    }
  });

  it("keeps command execution errors on backoff when announce delivery also fails", async () => {
    const cfg = createCronConfig("server-cron-command-execution-failure");
    loadConfigMock.mockReturnValue(cfg);
    const deliveryError = "Channel is required (no configured channels detected)";
    sendCronAnnouncePayloadStrictMock.mockRejectedValueOnce(new Error(deliveryError));

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const job = await state.cron.add({
        name: "failed-headless-command",
        enabled: true,
        deleteAfterRun: false,
        schedule: { kind: "every", everyMs: 20_000, anchorMs: Date.now() },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: {
          kind: "command",
          argv: [process.execPath, "-e", "process.stderr.write('failed'); process.exit(7)"],
        },
      });

      const dueAtMs = job.state.nextRunAtMs;
      expect(dueAtMs).toBeTypeOf("number");
      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(dueAtMs ?? 0);
      try {
        await state.cron.run(job.id, "due");
      } finally {
        nowSpy.mockRestore();
      }

      const updated = state.cron.getJob(job.id);
      expect(updated?.state.lastRunStatus).toBe("error");
      expect(updated?.state.lastError).toBe("command exited with code 7");
      expect(updated?.state.consecutiveErrors).toBe(1);
      expect(updated?.state.lastDeliveryStatus).toBe("not-delivered");
      expect(updated?.state.lastDeliveryError).toBe(deliveryError);
      expect(updated?.state.nextRunAtMs).toBeGreaterThanOrEqual(
        (updated?.updatedAtMs ?? 0) + 30_000,
      );
    } finally {
      state.cron.stop();
    }
  });

  it("fails and retains a one-shot command when required delivery fails", async () => {
    const cfg = createCronConfig("server-cron-command-required-delivery-failure");
    loadConfigMock.mockReturnValue(cfg);
    const deliveryError = "network unavailable while delivering command output";
    sendCronAnnouncePayloadStrictMock.mockRejectedValueOnce(new Error(deliveryError));

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const job = await state.cron.add({
        name: "successful-command-required-delivery",
        enabled: true,
        deleteAfterRun: true,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: {
          kind: "command",
          argv: [process.execPath, "-e", "process.stdout.write('ok')"],
        },
        delivery: { mode: "announce", bestEffort: false },
      });

      await state.cron.run(job.id, "force");

      const updated = state.cron.getJob(job.id);
      expect(updated?.state.lastRunStatus).toBe("error");
      expect(updated?.state.lastError).toBe(deliveryError);
      expect(updated?.state.consecutiveErrors).toBe(1);
      expect(updated?.state.lastDeliveryStatus).toBe("not-delivered");
      expect(updated?.state.lastDeliveryError).toBe(deliveryError);
      expect(updated?.state.nextRunAtMs).toBeGreaterThanOrEqual(
        (updated?.updatedAtMs ?? 0) + 30_000,
      );
    } finally {
      state.cron.stop();
    }
  });

  it("keeps a successful command successful when explicit best-effort delivery fails", async () => {
    const cfg = createCronConfig("server-cron-command-explicit-best-effort-delivery-failure");
    loadConfigMock.mockReturnValue(cfg);
    const deliveryError = "Channel is required (no configured channels detected)";
    sendCronAnnouncePayloadStrictMock.mockRejectedValueOnce(new Error(deliveryError));

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const job = await state.cron.add({
        name: "successful-command-best-effort-delivery",
        enabled: true,
        deleteAfterRun: false,
        schedule: { kind: "every", everyMs: 20_000, anchorMs: Date.now() },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: {
          kind: "command",
          argv: [process.execPath, "-e", "process.stdout.write('ok')"],
        },
        delivery: { mode: "announce", bestEffort: true },
      });
      const normalNextRunAtMs = job.state.nextRunAtMs;

      await state.cron.run(job.id, "force");

      const updated = state.cron.getJob(job.id);
      expect(updated?.state.lastRunStatus).toBe("ok");
      expect(updated?.state.lastError).toBeUndefined();
      expect(updated?.state.consecutiveErrors ?? 0).toBe(0);
      expect(updated?.state.nextRunAtMs).toBe(normalNextRunAtMs);
      expect(updated?.state.lastDeliveryStatus).toBe("not-delivered");
      expect(updated?.state.lastDeliveryError).toBe(deliveryError);
    } finally {
      state.cron.stop();
    }
  });

  it("deletes a successful one-shot command even when announce delivery fails", async () => {
    const cfg = createCronConfig("server-cron-command-delivery-failure-delete");
    loadConfigMock.mockReturnValue(cfg);
    sendCronAnnouncePayloadStrictMock.mockRejectedValueOnce(
      new Error("Channel is required (no configured channels detected)"),
    );

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const job = await state.cron.add({
        name: "successful-delete-after-run-command",
        enabled: true,
        deleteAfterRun: true,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: {
          kind: "command",
          argv: [process.execPath, "-e", "process.stdout.write('ok')"],
        },
      });

      await state.cron.run(job.id, "force");

      expect(state.cron.getJob(job.id)).toBeUndefined();
    } finally {
      state.cron.stop();
    }
  });

  it("delivers isolated script notify through the cron announce path", async () => {
    const cfg = createCronConfig("server-cron-script-announce");
    cfg.cron = { ...cfg.cron, triggers: { enabled: true } };
    loadConfigMock.mockReturnValue(cfg);
    cronScriptExecutorMock.mockResolvedValueOnce({
      kind: "completed",
      notify: "queue changed",
      stateChanged: false,
    });

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const job = await state.cron.add({
        name: "script-announce",
        enabled: true,
        deleteAfterRun: false,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "script", script: "return { notify: 'queue changed' }" },
        delivery: { mode: "announce", channel: "telegram", to: "123", threadId: 456 },
      });

      await state.cron.run(job.id, "force");

      expect(cronScriptExecutorMock).toHaveBeenCalledWith(
        expect.objectContaining({
          jobId: job.id,
          script: "return { notify: 'queue changed' }",
          timeoutSeconds: 300,
          toolBudget: 50,
        }),
      );
      expect(sendCronAnnouncePayloadStrictMock).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          message: "queue changed",
          jobId: job.id,
          target: expect.objectContaining({ threadId: 456 }),
        }),
      );
      expect(state.cron.getJob(job.id)?.state.lastRunStatus).toBe("ok");
    } finally {
      state.cron.stop();
    }
  });

  it("delivers isolated script notify through the cron webhook path", async () => {
    const cfg = createCronConfig("server-cron-script-webhook");
    cfg.cron = { ...cfg.cron, triggers: { enabled: true } };
    loadConfigMock.mockReturnValue(cfg);
    cronScriptExecutorMock.mockResolvedValueOnce({
      kind: "completed",
      notify: "queue changed",
      stateChanged: false,
    });
    fetchWithSsrFGuardMock.mockResolvedValueOnce({ release: vi.fn() });

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const job = await state.cron.add({
        name: "script-webhook",
        enabled: true,
        deleteAfterRun: false,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "script", script: "return { notify: 'queue changed' }" },
        delivery: { mode: "webhook", to: "https://example.invalid/cron-finished" },
      });

      await state.cron.run(job.id, "force");

      expect(fetchWithSsrFGuardMock).toHaveBeenCalledOnce();
      const request = requireRecord(
        callArg(fetchWithSsrFGuardMock, 0, 0, "script webhook request"),
        "script webhook request",
      );
      expect(String(requireRecord(request.init, "fetch init").body)).toContain(
        '"summary":"queue changed"',
      );
      expect(state.cron.getJob(job.id)?.state.lastRunStatus).toBe("ok");
    } finally {
      state.cron.stop();
    }
  });

  it("does not deliver a script webhook when notify is absent", async () => {
    const cfg = createCronConfig("server-cron-script-webhook-silent");
    cfg.cron = { ...cfg.cron, triggers: { enabled: true } };
    loadConfigMock.mockReturnValue(cfg);
    cronScriptExecutorMock.mockResolvedValueOnce({ kind: "completed", stateChanged: false });

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const job = await state.cron.add({
        name: "silent-script-webhook",
        enabled: true,
        deleteAfterRun: false,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "script", script: "return {}" },
        delivery: { mode: "webhook", to: "https://example.invalid/cron-finished" },
      });

      await state.cron.run(job.id, "force");

      expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
      expect(state.cron.getJob(job.id)?.state.lastRunStatus).toBe("ok");
    } finally {
      state.cron.stop();
    }
  });

  it("does not invoke delivery when a script omits notify", async () => {
    const cfg = createCronConfig("server-cron-script-silent");
    cfg.cron = { ...cfg.cron, triggers: { enabled: true } };
    loadConfigMock.mockReturnValue(cfg);
    cronScriptExecutorMock.mockResolvedValueOnce({ kind: "completed", stateChanged: false });

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const job = await state.cron.add({
        name: "silent-script",
        enabled: true,
        deleteAfterRun: false,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "script", script: "return {}" },
        delivery: { mode: "announce", channel: "telegram", to: "123" },
      });

      await state.cron.run(job.id, "force");

      expect(sendCronAnnouncePayloadStrictMock).not.toHaveBeenCalled();
      expect(state.cron.getJob(job.id)?.state.lastRunStatus).toBe("ok");
    } finally {
      state.cron.stop();
    }
  });

  it("suppresses command cron NO_REPLY output before webhook delivery", async () => {
    const cfg = createCronConfig("server-cron-command-webhook-no-reply");
    loadConfigMock.mockReturnValue(cfg);

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const job = await state.cron.add({
        name: "silent-command-webhook",
        enabled: true,
        deleteAfterRun: false,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: {
          kind: "command",
          argv: [process.execPath, "-e", "process.stdout.write('NO_REPLY\\n')"],
        },
        delivery: {
          mode: "webhook",
          to: "https://example.invalid/cron-finished",
        },
      });

      await state.cron.run(job.id, "force");

      expect(state.cron.getJob(job.id)?.state.lastRunStatus).toBe("ok");
      expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
    } finally {
      state.cron.stop();
    }
  });

  it("redacts command summary before cron_changed hook delivery", async () => {
    const cfg = createCronConfig("server-cron-command-hook-redaction");
    loadConfigMock.mockReturnValue(cfg);

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const job = await state.cron.add({
        name: "hook-redacted-command",
        enabled: true,
        deleteAfterRun: false,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: {
          kind: "command",
          argv: [
            process.execPath,
            "-e",
            "process.stdout.write('Visit www.example.com/device and enter code 123456; Log in with token=opaque-secret-value\\n')",
          ],
        },
      });

      runCronChangedMock.mockClear();
      await state.cron.run(job.id, "force");

      const event = runCronChangedMock.mock.calls
        .map((_, index) =>
          requireRecord(
            callArg(runCronChangedMock, index, 0, "cron_changed event"),
            "cron_changed event",
          ),
        )
        .find((hookEvent) => hookEvent.action === "finished");
      const summary = typeof event?.summary === "string" ? event.summary : "";
      expect(summary).toContain("[redacted-url]");
      expect(summary).toContain("[redacted-code]");
      expect(summary).toContain("token=***");
      expect(summary).not.toContain("www.example.com/device");
      expect(summary).not.toContain("123456");
      expect(summary).not.toContain("opaque-secret-value");
    } finally {
      state.cron.stop();
    }
  });

  it("redacts command summary secrets before announce delivery", async () => {
    const cfg = createCronConfig("server-cron-command-announce-redaction");
    loadConfigMock.mockReturnValue(cfg);

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const job = await state.cron.add({
        name: "announce-redacted-command",
        enabled: true,
        deleteAfterRun: false,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: {
          kind: "command",
          argv: [
            process.execPath,
            "-e",
            "process.stdout.write('Log in with token=opaque-secret-value\\n')",
          ],
        },
        delivery: {
          mode: "announce",
          channel: "telegram",
          to: "123",
        },
      });

      await state.cron.run(job.id, "force");

      const announcePayload = requireRecord(
        callArg(sendCronAnnouncePayloadStrictMock, 0, 0, "cron announce payload"),
        "cron announce payload",
      );
      const message = typeof announcePayload.message === "string" ? announcePayload.message : "";
      expect(message).toContain("token=***");
      expect(message).not.toContain("opaque-secret-value");
      expect(state.cron.getJob(job.id)?.state.lastRunStatus).toBe("ok");
      expect(state.cron.getJob(job.id)?.state.lastDeliveryStatus).toBe("delivered");
    } finally {
      state.cron.stop();
    }
  });

  it("leaves non-command cron_changed summaries unchanged", async () => {
    const cfg = createCronConfig("server-cron-non-command-summary");
    loadConfigMock.mockReturnValue(cfg);
    const summary = "Visit https://example.com/report and enter code ABCD-EFGH";
    runCronIsolatedAgentTurnMock.mockResolvedValueOnce({ status: "ok", summary });

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const job = await state.cron.add({
        name: "non-command-summary",
        enabled: true,
        deleteAfterRun: false,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "report" },
        delivery: {
          mode: "announce",
          channel: "telegram",
          to: "123",
        },
      });

      runCronChangedMock.mockClear();
      await state.cron.run(job.id, "force");

      expect(sendCronAnnouncePayloadStrictMock).not.toHaveBeenCalled();

      const event = runCronChangedMock.mock.calls
        .map((_, index) =>
          requireRecord(
            callArg(runCronChangedMock, index, 0, "cron_changed event"),
            "cron_changed event",
          ),
        )
        .find((hookEvent) => hookEvent.action === "finished");
      expect(event?.summary).toBe(summary);
    } finally {
      state.cron.stop();
    }
  });

  it("routes global-scope main cron jobs through the global queue for queued wakes", async () => {
    const cfg = {
      ...createCronConfig("server-cron-global-queued"),
      session: { mainKey: "main", scope: "global" },
    } as OpenClawConfig;
    loadConfigMock.mockReturnValue(cfg);

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const job = await state.cron.add({
        name: "global-queued",
        enabled: true,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "hello global" },
      });

      await state.cron.run(job.id, "force");

      expect(callArg(enqueueSystemEventMock, 0, 0, "system event text")).toBe("hello global");
      const eventOptions = requireRecord(
        callArg(enqueueSystemEventMock, 0, 1, "system event options"),
        "options",
      );
      expect(eventOptions.sessionKey).toBe("global");
      const heartbeatRequest = requireRecord(
        callArg(requestHeartbeatMock, 0, 0, "heartbeat request"),
        "request",
      );
      expect(heartbeatRequest.agentId).toBe("main");
      expect(heartbeatRequest.sessionKey).toBe("global");
    } finally {
      state.cron.stop();
    }
  });

  it("routes global-scope immediate main cron jobs through the global heartbeat lane", async () => {
    const cfg = {
      ...createCronConfig("server-cron-global-now"),
      session: { mainKey: "main", scope: "global" },
    } as OpenClawConfig;
    loadConfigMock.mockReturnValue(cfg);

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const job = await state.cron.add({
        name: "global-now",
        enabled: true,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "systemEvent", text: "hello now" },
      });

      await state.cron.run(job.id, "force");

      const eventOptions = requireRecord(
        callArg(enqueueSystemEventMock, 0, 1, "system event options"),
        "options",
      );
      expect(eventOptions.sessionKey).toBe("global");
      const heartbeatRun = requireRecord(
        callArg(runHeartbeatOnceMock, 0, 0, "heartbeat run options"),
        "heartbeat run options",
      );
      expect(heartbeatRun.agentId).toBe("main");
      expect(heartbeatRun.sessionKey).toBe("global");
      // The adapter rebuilds this object field-by-field; preserve the optional owner.
      expect(heartbeatRun.owningCronJobMarker).toMatchObject({ jobId: job.id });
      expect(heartbeatRun.heartbeat).toEqual({
        target: "last",
        to: undefined,
        accountId: undefined,
      });
    } finally {
      state.cron.stop();
    }
  });

  it("forwards heartbeat overrides through the cron wake adapter", () => {
    const cfg = createCronConfig("server-cron-heartbeat-override");
    loadConfigMock.mockReturnValue(cfg);

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const cronDeps = (
        state.cron as unknown as {
          state?: {
            deps?: {
              requestHeartbeat?: (opts?: {
                agentId?: string;
                sessionKey?: string | null;
                reason?: string;
                source?: string;
                intent?: string;
                heartbeat?: { target?: string };
              }) => void;
            };
          };
        }
      ).state?.deps;

      cronDeps?.requestHeartbeat?.({
        source: "cron",
        intent: "event",
        reason: "cron:test",
        sessionKey: "discord:channel:ops",
        heartbeat: { target: "last" },
      });

      expect(requestHeartbeatMock).toHaveBeenCalledWith({
        source: "cron",
        intent: "event",
        reason: "cron:test",
        agentId: "main",
        sessionKey: "agent:main:discord:channel:ops",
        heartbeat: { target: "last", to: undefined, accountId: undefined },
      });
    } finally {
      state.cron.stop();
    }
  });

  it("does not inherit explicit heartbeat destinations for direct target-last wakes", async () => {
    const cfg = {
      ...createCronConfig("server-cron-direct-heartbeat-route"),
      agents: {
        defaults: {
          heartbeat: {
            every: "1h",
            prompt: "Default heartbeat prompt",
            target: "none",
            directPolicy: "block",
            to: "telegram:dm",
            accountId: "default",
          },
        },
      },
    } as OpenClawConfig;
    loadConfigMock.mockReturnValue(cfg);

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const cronDeps = (
        state.cron as unknown as {
          state?: {
            deps?: {
              runHeartbeatOnce?: (opts?: {
                agentId?: string;
                sessionKey?: string | null;
                reason?: string;
                owningCronLaneTaskMarker?: {
                  lane: string;
                  taskId: number;
                  generation: number;
                };
                heartbeat?: { target?: string };
              }) => Promise<unknown>;
            };
          };
        }
      ).state?.deps;

      const owningCronLaneTaskMarker = { lane: "cron", taskId: 7, generation: 3 };
      await cronDeps?.runHeartbeatOnce?.({
        reason: "cron:test",
        sessionKey: "telegram:group:123:topic:456",
        owningCronLaneTaskMarker,
        heartbeat: { target: "last" },
      });

      const call = requireRecord(
        callArg(runHeartbeatOnceMock, 0, 0, "heartbeat run options"),
        "heartbeat run options",
      );
      expect(call.sessionKey).toBe("agent:main:telegram:group:123:topic:456");
      expect(call.owningCronLaneTaskMarker).toEqual(owningCronLaneTaskMarker);
      expect(call.heartbeat).toEqual({
        every: "1h",
        prompt: "Default heartbeat prompt",
        target: "last",
        directPolicy: "block",
        to: undefined,
        accountId: undefined,
      });
    } finally {
      state.cron.stop();
    }
  });

  it("does not inherit explicit heartbeat destinations for queued target-last wakes", async () => {
    const cfg = {
      ...createCronConfig("server-cron-queued-heartbeat-route"),
      agents: {
        defaults: {
          heartbeat: {
            every: "1h",
            prompt: "Default heartbeat prompt",
            target: "none",
            directPolicy: "block",
            to: "telegram:dm",
            accountId: "default",
          },
        },
      },
    } as OpenClawConfig;
    loadConfigMock.mockReturnValue(cfg);

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const job = await state.cron.add({
        name: "queued-heartbeat-route",
        enabled: true,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        sessionKey: "telegram:group:123:topic:456",
        payload: { kind: "systemEvent", text: "hello" },
      });

      await state.cron.run(job.id, "force");

      const call = requireRecord(
        callArg(requestHeartbeatMock, 0, 0, "heartbeat request"),
        "heartbeat request",
      );
      expectMainCronRunSessionKey(call.sessionKey, job.id);
      expect(call.heartbeat).toEqual({
        target: "last",
        to: undefined,
        accountId: undefined,
      });
    } finally {
      state.cron.stop();
    }
  });

  it("preserves untargeted cron wake requests for heartbeat fanout", () => {
    const cfg = {
      session: { mainKey: "main" },
      cron: { store: path.join(os.tmpdir(), `server-cron-untargeted-${Date.now()}`, "cron.json") },
      agents: {
        list: [
          { id: "primary", default: true, model: "test/primary" },
          { id: "ops", model: "test/ops" },
        ],
      },
    } as unknown as OpenClawConfig;
    loadConfigMock.mockReturnValue(cfg);

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const cronDeps = (
        state.cron as unknown as {
          state?: {
            deps?: {
              requestHeartbeat?: (opts?: {
                source?: string;
                intent?: string;
                reason?: string;
              }) => void;
            };
          };
        }
      ).state?.deps;

      cronDeps?.requestHeartbeat?.({
        source: "cron",
        intent: "immediate",
        reason: "cron:job:failure-alert",
      });

      expect(requestHeartbeatMock).toHaveBeenCalledWith({
        source: "cron",
        intent: "immediate",
        reason: "cron:job:failure-alert",
        agentId: undefined,
        sessionKey: undefined,
        heartbeat: undefined,
      });
    } finally {
      state.cron.stop();
    }
  });

  it("derives agentId symmetrically for enqueue and wake when only an agent-prefixed sessionKey is supplied", () => {
    // Multi-agent setup where the configured default ("primary") is NOT the
    // agent referenced in the sessionKey ("ops"). Pre-PR, enqueue went through
    // resolveCronSessionKey which treated a non-default agent's key as foreign
    // and rerouted to primary's main session, while requestHeartbeat correctly
    // derived agentId from the key — so wake hit ops while the event landed in
    // primary's queue. Both adapter call sites now derive agentId from the
    // session key the same way.
    const cfg = {
      session: { mainKey: "main" },
      cron: { store: path.join(os.tmpdir(), `server-cron-symmetric-${Date.now()}`, "cron.json") },
      agents: {
        list: [
          { id: "primary", default: true, model: "test/primary" },
          { id: "ops", model: "test/ops" },
        ],
      },
    } as unknown as OpenClawConfig;
    loadConfigMock.mockReturnValue(cfg);

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const cronDeps = (
        state.cron as unknown as {
          state?: {
            deps?: {
              enqueueSystemEvent?: (
                text: string,
                opts?: { agentId?: string; sessionKey?: string; contextKey?: string },
              ) => void;
              requestHeartbeat?: (opts?: {
                agentId?: string;
                sessionKey?: string | null;
                source?: string;
                intent?: string;
                reason?: string;
              }) => void;
            };
          };
        }
      ).state?.deps;

      const foreignKey = "agent:ops:cron:nightly:run:abc-123";

      cronDeps?.enqueueSystemEvent?.("hello", {
        sessionKey: foreignKey,
        contextKey: "cron:test",
      });
      cronDeps?.requestHeartbeat?.({
        source: "cron",
        intent: "event",
        reason: "cron:test",
        sessionKey: foreignKey,
      });

      // Both must derive agentId="ops" from the key, NOT fall back to the
      // configured default "primary". The exact resolved sessionKey is
      // delegated to resolveCronSessionKey (already covered by other tests);
      // here we only assert the agent target is consistent across both sides.
      const enqueueCall = lastMockCall(enqueueSystemEventMock, "enqueue system event");
      const wakeCall = lastMockCall(requestHeartbeatMock, "request heartbeat");
      const enqueueSessionKey = (enqueueCall?.[1] as { sessionKey?: string } | undefined)
        ?.sessionKey;
      const wakeOpts = wakeCall?.[0] as { agentId?: string; sessionKey?: string } | undefined;

      if (!enqueueSessionKey) {
        throw new Error("Expected enqueue session key");
      }
      expect(enqueueSessionKey).toMatch(/^agent:ops:/);
      expect(wakeOpts?.agentId).toBe("ops");
      expect(wakeOpts?.sessionKey).toMatch(/^agent:ops:/);
    } finally {
      state.cron.stop();
    }
  });

  it("routes relative cron wake session keys to the configured default agent", () => {
    const cfg = {
      session: { mainKey: "main" },
      cron: {
        store: path.join(os.tmpdir(), `server-cron-relative-default-${Date.now()}`, "cron.json"),
      },
      agents: {
        list: [
          { id: "primary", default: true, model: "test/primary" },
          { id: "main", model: "test/main" },
        ],
      },
    } as unknown as OpenClawConfig;
    loadConfigMock.mockReturnValue(cfg);

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const cronDeps = (
        state.cron as unknown as {
          state?: {
            deps?: {
              enqueueSystemEvent?: (text: string, opts?: { sessionKey?: string }) => void;
              requestHeartbeat?: (opts?: {
                sessionKey?: string | null;
                source?: string;
                intent?: string;
                reason?: string;
              }) => void;
            };
          };
        }
      ).state?.deps;

      cronDeps?.enqueueSystemEvent?.("hello", {
        sessionKey: "discord:channel:ops",
      });
      cronDeps?.requestHeartbeat?.({
        source: "cron",
        intent: "event",
        reason: "cron:test",
        sessionKey: "discord:channel:ops",
      });

      const enqueueCall = lastMockCall(enqueueSystemEventMock, "enqueue system event");
      const wakeCall = lastMockCall(requestHeartbeatMock, "request heartbeat");
      expect((enqueueCall?.[1] as { sessionKey?: string } | undefined)?.sessionKey).toBe(
        "agent:primary:discord:channel:ops",
      );
      const wakeRequest = wakeCall?.[0] as { agentId?: string; sessionKey?: string } | undefined;
      expect(wakeRequest?.agentId).toBe("primary");
      expect(wakeRequest?.sessionKey).toBe("agent:primary:discord:channel:ops");
    } finally {
      state.cron.stop();
    }
  });

  it("rejects unknown agent-prefixed keys instead of rebinding them to the default agent", () => {
    const cfg = {
      session: { mainKey: "main" },
      cron: {
        store: path.join(os.tmpdir(), `server-cron-unknown-agent-${Date.now()}`, "cron.json"),
      },
      agents: {
        list: [
          { id: "primary", default: true, model: "test/primary" },
          { id: "ops", model: "test/ops" },
        ],
      },
    } as unknown as OpenClawConfig;
    loadConfigMock.mockReturnValue(cfg);

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const cronDeps = (
        state.cron as unknown as {
          state?: {
            deps?: {
              enqueueSystemEvent?: (text: string, opts?: { sessionKey?: string }) => void;
              requestHeartbeat?: (opts?: {
                sessionKey?: string | null;
                source?: string;
                intent?: string;
                reason?: string;
              }) => void;
            };
          };
        }
      ).state?.deps;

      expect(() =>
        cronDeps?.enqueueSystemEvent?.("hello", {
          sessionKey: "agent:ghost:discord:channel:ops",
        }),
      ).toThrow("cron job agent is unavailable: ghost");
      expect(() =>
        cronDeps?.requestHeartbeat?.({
          source: "cron",
          intent: "event",
          reason: "cron:test",
          sessionKey: "agent:ghost:discord:channel:ops",
        }),
      ).toThrow("cron job agent is unavailable: ghost");
      expect(enqueueSystemEventMock).not.toHaveBeenCalled();
      expect(requestHeartbeatMock).not.toHaveBeenCalled();
    } finally {
      state.cron.stop();
    }
  });

  it("threads cron wake sessionKey through the CronService adapter", () => {
    const cfg = {
      session: { mainKey: "main" },
      cron: {
        store: path.join(os.tmpdir(), `server-cron-wake-service-${Date.now()}`, "cron.json"),
      },
      agents: {
        list: [
          { id: "primary", default: true, model: "test/primary" },
          { id: "ops", model: "test/ops" },
        ],
      },
    } as unknown as OpenClawConfig;
    loadConfigMock.mockReturnValue(cfg);

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const sessionKey = "agent:ops:cron:nightly:run:abc-123";
      expect(
        state.cron.wake({
          mode: "now",
          text: "hello",
          sessionKey,
        }),
      ).toEqual({ ok: true });

      const enqueueCall = lastMockCall(enqueueSystemEventMock, "enqueue system event");
      const wakeCall = lastMockCall(requestHeartbeatMock, "request heartbeat");
      expect(enqueueCall?.[0]).toBe("hello");
      expect((enqueueCall?.[1] as { sessionKey?: string } | undefined)?.sessionKey).toMatch(
        /^agent:ops:/,
      );
      const wakeRequest = wakeCall?.[0] as
        | {
            source?: string;
            intent?: string;
            reason?: string;
            agentId?: string;
            sessionKey?: string;
          }
        | undefined;
      expect(wakeRequest?.source).toBe("manual");
      expect(wakeRequest?.intent).toBe("immediate");
      expect(wakeRequest?.reason).toBe("wake");
      expect(wakeRequest?.agentId).toBe("ops");
      expect(wakeRequest?.sessionKey).toMatch(/^agent:ops:/);
    } finally {
      state.cron.stop();
    }
  });

  it("forwards cron system events to the resolved session", () => {
    const cfg = createCronConfig("server-cron-system-event");
    loadConfigMock.mockReturnValue(cfg);

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const cronDeps = (
        state.cron as unknown as {
          state?: {
            deps?: {
              enqueueSystemEvent?: (
                optsText: string,
                opts?: {
                  agentId?: string;
                  sessionKey?: string;
                  contextKey?: string;
                },
              ) => void;
            };
          };
        }
      ).state?.deps;

      cronDeps?.enqueueSystemEvent?.("hello", {
        sessionKey: "discord:channel:ops",
        contextKey: "cron:test",
      });

      expect(enqueueSystemEventMock).toHaveBeenCalledWith("hello", {
        sessionKey: "agent:main:discord:channel:ops",
        contextKey: "cron:test",
      });
    } finally {
      state.cron.stop();
    }
  });

  it("blocks private webhook URLs via SSRF-guarded fetch", async () => {
    const cfg = createCronConfig("server-cron-ssrf");
    loadConfigMock.mockReturnValue(cfg);
    fetchWithSsrFGuardMock.mockRejectedValue(
      new SsrFBlockedError("Blocked: resolves to private/internal/special-use IP address"),
    );

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const job = await state.cron.add({
        name: "ssrf-webhook-blocked",
        enabled: true,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "hello" },
        delivery: {
          mode: "webhook",
          to: "http://127.0.0.1:8080/cron-finished",
        },
      });

      await state.cron.run(job.id, "force");

      expect(fetchWithSsrFGuardMock).toHaveBeenCalledOnce();
      const request = requireRecord(
        callArg(fetchWithSsrFGuardMock, 0, 0, "fetch request"),
        "fetch request",
      );
      expect(request.url).toBe("http://127.0.0.1:8080/cron-finished");
      const init = requireRecord(request.init, "fetch init");
      expect(init.method).toBe("POST");
      expect(init.headers).toEqual({ "Content-Type": "application/json" });
      expect(String(init.body)).toContain('"action":"finished"');
      expect(init.signal).toBeInstanceOf(AbortSignal);
    } finally {
      state.cron.stop();
    }
  });

  it("passes opaque custom session targets through to isolated cron runs", async () => {
    const tmpDir = path.join(os.tmpdir(), `server-cron-custom-session-${Date.now()}`);
    const cfg = {
      session: {
        mainKey: "main",
      },
      cron: {
        store: path.join(tmpDir, "cron.json"),
      },
    } as OpenClawConfig;
    loadConfigMock.mockReturnValue(cfg);

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const sessionKey = "agent:main:dingtalk:group:cid3tmd4xb19xjfk/wogxwy2a==";
      const job = await state.cron.add({
        name: "custom-session",
        enabled: true,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: `session:${sessionKey}`,
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "hello" },
      });

      await state.cron.run(job.id, "force");

      const options = expectIsolatedRunFields({ sessionKey });
      expect(requireRecord(options.job, "isolated job").id).toBe(job.id);
      expectCleanupForSessionKeys([sessionKey]);
    } finally {
      state.cron.stop();
    }
  });

  it("uses a dedicated cron session key for isolated jobs with model overrides", async () => {
    const cfg = createCronConfig("server-cron-isolated-key");
    loadConfigMock.mockReturnValue(cfg);

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const job = await state.cron.add({
        name: "isolated-model-override",
        enabled: true,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: {
          kind: "agentTurn",
          message: "run report",
          model: "ollama/kimi-k2.5:cloud",
        },
      });

      await state.cron.run(job.id, "force");

      const options = expectIsolatedRunFields({ sessionKey: `cron:${job.id}` });
      expect(requireRecord(options.job, "isolated job").id).toBe(job.id);
      const isolatedRunCalls = runCronIsolatedAgentTurnMock.mock.calls as Array<Array<unknown>>;
      expect(
        isolatedRunCalls.some(([value]) => {
          const record =
            value && typeof value === "object" ? (value as Record<string, unknown>) : {};
          return record.sessionKey === "main";
        }),
      ).toBe(false);
      expectCleanupForSessionKeys([`cron:${job.id}`]);
    } finally {
      state.cron.stop();
    }
  });

  it("does not resurrect a startup agent missing from the runtime roster", async () => {
    const tmpDir = path.join(os.tmpdir(), `server-cron-agent-workspace-${Date.now()}`);
    const startupCfg = {
      session: {
        mainKey: "main",
      },
      cron: {
        store: path.join(tmpDir, "cron.json"),
      },
      agents: {
        defaults: {
          workspace: path.join(tmpDir, "workspace"),
        },
        list: [
          { id: "main", default: true },
          { id: "yinze", workspace: path.join(tmpDir, "workspace-yinze") },
        ],
      },
    } as OpenClawConfig;
    const reloadedCfg = {
      session: {
        mainKey: "main",
      },
      cron: {
        store: path.join(tmpDir, "cron.json"),
      },
      agents: {
        defaults: {
          workspace: path.join(tmpDir, "workspace"),
        },
        list: [{ id: "main", default: true }],
      },
    } as OpenClawConfig;
    loadConfigMock.mockReturnValue(startupCfg);

    const state = buildGatewayCronService({
      cfg: startupCfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const job = await state.cron.add({
        name: "isolated-subagent-workspace",
        enabled: true,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        agentId: "yinze",
        payload: { kind: "agentTurn", message: "read SOW.md" },
      });

      loadConfigMock.mockReturnValue(reloadedCfg);
      await expect(state.cron.run(job.id, "force")).resolves.toEqual({ ok: true, ran: true });
      expect(runCronIsolatedAgentTurnMock).not.toHaveBeenCalled();
      expect(await state.cron.readJob(job.id)).toMatchObject({
        state: {
          lastRunStatus: "error",
          lastError: expect.stringContaining("cron job agent is unavailable: yinze"),
        },
      });
    } finally {
      state.cron.stop();
    }
  });

  it("removes only one agent's cron jobs and restores them if roster commit fails", async () => {
    const tmpDir = path.join(os.tmpdir(), `server-cron-agent-delete-${Date.now()}`);
    const cfg = {
      cron: { store: path.join(tmpDir, "cron.json") },
      agents: {
        defaults: { workspace: path.join(tmpDir, "workspace") },
        list: [{ id: "main", default: true }, { id: "yinze" }, { id: "other" }],
      },
    } as OpenClawConfig;
    loadConfigMock.mockReturnValue(cfg);
    const state = buildGatewayCronService({ cfg, deps: {} as CliDeps, broadcast: () => {} });
    const addJob = async (agentId: string, name: string) =>
      await state.cron.add({
        name,
        enabled: true,
        schedule: { kind: "at", at: new Date(Date.now() + 3_600_000).toISOString() },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        agentId,
        payload: { kind: "agentTurn", message: name },
      });
    try {
      await addJob("yinze", "deleted-one");
      await addJob("yinze", "deleted-two");
      await addJob("other", "kept");

      await expect(
        state.cron.removeAgentJobsTransactional("yinze", async () => {
          throw new Error("config commit failed");
        }),
      ).rejects.toThrow("config commit failed");
      expect((await state.cron.list({ includeDisabled: true })).map((job) => job.name)).toEqual(
        expect.arrayContaining(["deleted-one", "deleted-two", "kept"]),
      );

      await state.cron.removeAgentJobsTransactional("yinze", async () => "committed");
      expect((await state.cron.list({ includeDisabled: true })).map((job) => job.name)).toEqual([
        "kept",
      ]);
    } finally {
      state.cron.stop();
    }
  });

  it("keeps removed jobs deleted when the roster commit outcome is uncertain", async () => {
    const tmpDir = path.join(os.tmpdir(), `server-cron-agent-uncertain-${Date.now()}`);
    const cfg = {
      cron: { store: path.join(tmpDir, "cron.json") },
      agents: { list: [{ id: "main", default: true }, { id: "yinze" }, { id: "other" }] },
    } as OpenClawConfig;
    loadConfigMock.mockReturnValue(cfg);
    const state = buildGatewayCronService({ cfg, deps: {} as CliDeps, broadcast: () => {} });
    try {
      for (const [agentId, name] of [
        ["yinze", "deleted"],
        ["other", "kept"],
      ] as const) {
        await state.cron.add({
          name,
          enabled: true,
          schedule: { kind: "at", at: new Date(Date.now() + 3_600_000).toISOString() },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          agentId,
          payload: { kind: "agentTurn", message: name },
        });
      }

      await expect(
        state.cron.removeAgentJobsTransactional("yinze", async () => {
          throw new AgentDeletionCommitUncertainError(new Error("config outcome unknown"));
        }),
      ).rejects.toThrow("config outcome unknown");
      expect((await state.cron.list({ includeDisabled: true })).map((job) => job.name)).toEqual([
        "kept",
      ]);
    } finally {
      state.cron.stop();
    }
  });

  it("keeps agent-less jobs owned by the current runtime default", async () => {
    const tmpDir = path.join(os.tmpdir(), `server-cron-default-change-${Date.now()}`);
    const startupCfg = {
      cron: { store: path.join(tmpDir, "cron.json") },
      agents: { list: [{ id: "main" }, { id: "yinze", default: true }, { id: "other" }] },
    } as OpenClawConfig;
    const runtimeCfg = {
      ...startupCfg,
      agents: { list: [{ id: "main" }, { id: "yinze" }, { id: "other", default: true }] },
    } as OpenClawConfig;
    loadConfigMock.mockReturnValue(startupCfg);
    const state = buildGatewayCronService({
      cfg: startupCfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      await state.cron.add({
        name: "follows-runtime-default",
        enabled: true,
        schedule: { kind: "at", at: new Date(Date.now() + 3_600_000).toISOString() },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "keep" },
      });
      loadConfigMock.mockReturnValue(runtimeCfg);

      await state.cron.removeAgentJobsTransactional("yinze", async () => {});
      await expect(
        state.cron.add({
          name: "new-runtime-default",
          enabled: true,
          schedule: { kind: "at", at: new Date(Date.now() + 3_600_000).toISOString() },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          payload: { kind: "agentTurn", message: "keep too" },
        }),
      ).resolves.toBeDefined();
      expect((await state.cron.list({ includeDisabled: true })).map((job) => job.name)).toEqual([
        "follows-runtime-default",
        "new-runtime-default",
      ]);
    } finally {
      state.cron.stop();
    }
  });

  it("does not execute jobs for a journal-fenced agent still present in the roster", async () => {
    const tmpDir = path.join(os.tmpdir(), `server-cron-agent-fenced-${Date.now()}`);
    const cfg = {
      cron: { store: path.join(tmpDir, "cron.json") },
      agents: { list: [{ id: "main", default: true }, { id: "yinze" }] },
    } as OpenClawConfig;
    loadConfigMock.mockReturnValue(cfg);
    const state = buildGatewayCronService({ cfg, deps: {} as CliDeps, broadcast: () => {} });
    try {
      const job = await state.cron.add({
        name: "fenced-job",
        enabled: true,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        agentId: "yinze",
        payload: { kind: "agentTurn", message: "must not run" },
      });
      isAgentDeletionBlockedMock.mockImplementation((agentId: string) => agentId === "yinze");

      await expect(state.cron.run(job.id, "force")).resolves.toEqual({ ok: true, ran: true });
      expect(runCronIsolatedAgentTurnMock).not.toHaveBeenCalled();
      expect(await state.cron.readJob(job.id)).toMatchObject({
        state: {
          lastRunStatus: "error",
          lastError: expect.stringContaining("cron job agent is unavailable: yinze"),
        },
      });
    } finally {
      state.cron.stop();
    }
  });

  it("rejects an agent job queued while that agent is removed from the roster", async () => {
    const tmpDir = path.join(os.tmpdir(), `server-cron-agent-delete-race-${Date.now()}`);
    const cfg = {
      cron: { store: path.join(tmpDir, "cron.json") },
      agents: {
        defaults: { workspace: path.join(tmpDir, "workspace") },
        list: [{ id: "main", default: true }, { id: "yinze" }],
      },
    } as OpenClawConfig;
    const deletedCfg = {
      ...cfg,
      agents: { ...cfg.agents, list: [{ id: "main", default: true }] },
    } as OpenClawConfig;
    loadConfigMock.mockReturnValue(cfg);
    const state = buildGatewayCronService({ cfg, deps: {} as CliDeps, broadcast: () => {} });
    const commitStarted = createDeferred();
    const releaseCommit = createDeferred();
    try {
      await state.cron.add({
        name: "old-job",
        enabled: true,
        schedule: { kind: "at", at: new Date(Date.now() + 3_600_000).toISOString() },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        agentId: "yinze",
        payload: { kind: "agentTurn", message: "old" },
      });
      const retained = await state.cron.add({
        name: "retained-job",
        enabled: true,
        schedule: { kind: "at", at: new Date(Date.now() + 3_600_000).toISOString() },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        agentId: "main",
        payload: { kind: "agentTurn", message: "retained" },
      });
      const removal = state.cron.removeAgentJobsTransactional("yinze", async () => {
        commitStarted.resolve();
        await releaseCommit.promise;
      });
      await commitStarted.promise;
      loadConfigMock.mockReturnValue(deletedCfg);
      const lateAdd = state.cron.add({
        name: "late-job",
        enabled: true,
        schedule: { kind: "at", at: new Date(Date.now() + 3_600_000).toISOString() },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        agentId: "yinze",
        payload: { kind: "agentTurn", message: "late" },
      });
      const lateUpdate = state.cron.update(retained.id, { agentId: "yinze" });
      releaseCommit.resolve();

      await removal;
      await expect(lateAdd).rejects.toThrow("cron job agent is unavailable: yinze");
      await expect(lateUpdate).rejects.toThrow("cron job agent is unavailable: yinze");
      expect((await state.cron.list({ includeDisabled: true })).map((job) => job.name)).toEqual([
        "retained-job",
      ]);
    } finally {
      releaseCommit.resolve();
      state.cron.stop();
    }
  });

  it("does not reuse startup heartbeat policy for an agent missing from the runtime roster", async () => {
    const tmpDir = path.join(os.tmpdir(), `server-cron-agent-heartbeat-${Date.now()}`);
    const startupCfg = {
      session: {
        mainKey: "main",
      },
      cron: {
        store: path.join(tmpDir, "cron.json"),
      },
      agents: {
        defaults: {
          workspace: path.join(tmpDir, "workspace"),
          heartbeat: {
            target: "main",
            deliveryFormat: "text",
          },
        },
        list: [
          { id: "main", default: true },
          {
            id: "yinze",
            workspace: path.join(tmpDir, "workspace-yinze"),
            heartbeat: {
              target: "last",
              deliveryFormat: "markdown",
            },
          },
        ],
      },
    } as OpenClawConfig;
    const reloadedCfg = {
      session: {
        mainKey: "main",
      },
      cron: {
        store: path.join(tmpDir, "cron.json"),
      },
      agents: {
        defaults: {
          workspace: path.join(tmpDir, "workspace"),
          heartbeat: {
            target: "main",
            deliveryFormat: "text",
          },
        },
        list: [{ id: "main", default: true }],
      },
    } as OpenClawConfig;
    loadConfigMock.mockReturnValue(reloadedCfg);

    const state = buildGatewayCronService({
      cfg: startupCfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const cronDeps = (
        state.cron as unknown as {
          state?: {
            deps?: {
              runHeartbeatOnce?: (opts?: {
                agentId?: string;
                sessionKey?: string | null;
                heartbeat?: Record<string, unknown>;
              }) => Promise<unknown>;
            };
          };
        }
      ).state?.deps;
      await expect(
        cronDeps?.runHeartbeatOnce?.({
          agentId: "yinze",
          sessionKey: "agent:yinze:main",
          heartbeat: {},
        }),
      ).rejects.toThrow("cron job agent is unavailable: yinze");
      expect(runHeartbeatOnceMock).not.toHaveBeenCalled();
    } finally {
      state.cron.stop();
    }
  });

  it("broadcasts refreshed session rows when cron bindings change", async () => {
    const cfg = createCronConfig("server-cron-binding-broadcast");
    const sessionStorePath = path.join(
      os.tmpdir(),
      `server-cron-binding-broadcast-sessions-${Date.now()}`,
      "sessions.json",
    );
    (cfg.session as { store?: string }).store = sessionStorePath;
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.dirname(sessionStorePath), { recursive: true });
    await fs.writeFile(
      sessionStorePath,
      JSON.stringify({
        "agent:main:probe": { sessionId: "sess-probe", updatedAt: Date.now() },
      }),
      "utf-8",
    );
    loadConfigMock.mockReturnValue(cfg);
    const broadcast = vi.fn();
    const state = buildGatewayCronService({ cfg, deps: {} as CliDeps, broadcast });
    try {
      // The automation source registers on start (stale-reload safety).
      await state.cron.start();
      const sessionsChanged = () =>
        broadcast.mock.calls.filter((call) => call[0] === "sessions.changed");
      const job = await state.cron.add({
        name: "bound schedule",
        enabled: true,
        schedule: { kind: "at", at: new Date(Date.now() + 3_600_000).toISOString() },
        sessionTarget: "session:agent:main:probe",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "ping" },
      });
      // Payload row fields depend on shared-process session-store state, so
      // this test pins only the broadcast mechanism; hasAutomation projection
      // is covered by session-utils and session-automation-index tests.
      const added = requireRecord(sessionsChanged().at(-1)?.[1], "added payload");
      expect(added.sessionKey).toBe("agent:main:probe");
      expect(added.reason).toBe("cron-binding");

      broadcast.mockClear();
      await state.cron.update(job.id, { enabled: false });
      const disabled = requireRecord(sessionsChanged().at(-1)?.[1], "disabled payload");
      expect(disabled.sessionKey).toBe("agent:main:probe");
      expect(disabled.reason).toBe("cron-binding");
    } finally {
      state.cron.stop();
    }
  });
});

describe("fireOnExitJob (on-exit fire routing)", () => {
  type ForceRunMock = (jobId: string, payload?: CronJob["payload"]) => Promise<void>;

  const job = (payload: unknown, extra: Partial<CronJob> = {}): CronJob =>
    ({ id: "job-x", payload, ...extra }) as unknown as CronJob;
  const exit = {
    exitCode: 3,
    reason: "exit",
    stdout: "built ok\n",
    stderr: "warned\n",
    timedOut: false,
    noOutputTimedOut: false,
  };

  it("executes an agentTurn payload via the force-run path, not a text wake", async () => {
    const run = vi.fn<ForceRunMock>(async () => {});
    const wake = vi.fn();
    await fireOnExitJob(job({ kind: "agentTurn", message: "go" }), exit, {
      run,
    });
    expect(run.mock.calls[0]?.[1]).toMatchObject({
      kind: "agentTurn",
      message: expect.stringContaining("Exit code: 3"),
    });
    expect(run.mock.calls[0]?.[1]).toMatchObject({
      message: expect.stringContaining("stdout:\nbuilt ok"),
    });
    expect(run.mock.calls[0]?.[0]).toBe("job-x");
    expect(wake).not.toHaveBeenCalled();
  });

  it("executes a command payload via the force-run path", async () => {
    const run = vi.fn<ForceRunMock>(async () => {});
    const wake = vi.fn();
    await fireOnExitJob(job({ kind: "command", argv: ["echo", "hi"] }), exit, {
      run,
    });
    expect(run).toHaveBeenCalledWith("job-x", undefined);
    expect(wake).not.toHaveBeenCalled();
  });

  it("executes a systemEvent payload via the force-run path", async () => {
    const run = vi.fn<ForceRunMock>(async () => {});
    const wake = vi.fn();
    await fireOnExitJob(
      job({ kind: "systemEvent", text: "done" }, { sessionKey: "sk-1", agentId: "agent-1" }),
      exit,
      { run },
    );
    expect(run.mock.calls[0]?.[1]).toMatchObject({
      kind: "systemEvent",
      text: expect.stringContaining("Exit code: 3"),
    });
    expect(run.mock.calls[0]?.[1]).toMatchObject({
      text: expect.stringContaining("stderr:\nwarned"),
    });
    expect(run.mock.calls[0]?.[0]).toBe("job-x");
    expect(wake).not.toHaveBeenCalled();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
