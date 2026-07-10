// Gateway cron tests cover isolated agent turns, heartbeat wakeups, completion
// delivery, lifecycle cleanup, hook emission, and SSRF-guarded webhooks.
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CliDeps } from "../cli/deps.js";
import type { OpenClawConfig } from "../config/config.js";
import { SsrFBlockedError } from "../infra/net/ssrf.js";
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

vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: getProcessSupervisorMock,
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

function requireArray(value: unknown, label: string): Array<unknown> {
  expect(Array.isArray(value), label).toBe(true);
  return value as Array<unknown>;
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
    getGlobalHookRunnerMock.mockReturnValue({
      hasHooks: (hookName: string) => hookName === "cron_changed",
      runCronChanged: runCronChangedMock,
    });
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
                heartbeat?: { target?: string };
              }) => Promise<unknown>;
            };
          };
        }
      ).state?.deps;

      await cronDeps?.runHeartbeatOnce?.({
        reason: "cron:test",
        sessionKey: "telegram:group:123:topic:456",
        heartbeat: { target: "last" },
      });

      const call = requireRecord(
        callArg(runHeartbeatOnceMock, 0, 0, "heartbeat run options"),
        "heartbeat run options",
      );
      expect(call.sessionKey).toBe("agent:main:telegram:group:123:topic:456");
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

  it("falls back to the configured default agent main session for unknown agent-prefixed keys", () => {
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

      cronDeps?.enqueueSystemEvent?.("hello", {
        sessionKey: "agent:ghost:discord:channel:ops",
      });
      cronDeps?.requestHeartbeat?.({
        source: "cron",
        intent: "event",
        reason: "cron:test",
        sessionKey: "agent:ghost:discord:channel:ops",
      });

      const enqueueCall = lastMockCall(enqueueSystemEventMock, "enqueue system event");
      const wakeCall = lastMockCall(requestHeartbeatMock, "request heartbeat");
      expect((enqueueCall?.[1] as { sessionKey?: string } | undefined)?.sessionKey).toBe(
        "agent:primary:main",
      );
      const wakeRequest = wakeCall?.[0] as { agentId?: string; sessionKey?: string } | undefined;
      expect(wakeRequest?.agentId).toBe("primary");
      expect(wakeRequest?.sessionKey).toBe("agent:primary:main");
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

  it("preserves explicit isolated agent workspace when runtime reload config is stale", async () => {
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
    loadConfigMock.mockReturnValue(reloadedCfg);

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

      await state.cron.run(job.id, "force");

      const options = expectIsolatedRunFields({ agentId: "yinze" });
      const cfg = requireRecord(options.cfg, "isolated run config");
      const agents = requireRecord(cfg.agents, "isolated run agents");
      const list = requireArray(agents.list, "isolated run agent list");
      const yinze = requireRecord(
        list.find((agent) => requireRecord(agent, "agent entry").id === "yinze"),
        "yinze agent entry",
      );
      expect(yinze.workspace).toBe(path.join(tmpDir, "workspace-yinze"));
    } finally {
      state.cron.stop();
    }
  });

  it("preserves agent heartbeat overrides when runtime reload config is stale", async () => {
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
      await cronDeps?.runHeartbeatOnce?.({
        agentId: "yinze",
        sessionKey: "agent:yinze:main",
        heartbeat: {},
      });

      const options = requireRecord(
        callArg(runHeartbeatOnceMock, 0, 0, "heartbeat options"),
        "heartbeat options",
      );
      expect(options.agentId).toBe("yinze");
      const cfg = requireRecord(options.cfg, "heartbeat config");
      const agents = requireRecord(cfg.agents, "heartbeat agents");
      const list = requireArray(agents.list, "heartbeat agent list");
      const yinze = requireRecord(
        list.find((agent) => requireRecord(agent, "agent entry").id === "yinze"),
        "yinze agent entry",
      );
      const agentHeartbeat = requireRecord(yinze.heartbeat, "agent heartbeat");
      expect(agentHeartbeat.target).toBe("last");
      expect(agentHeartbeat.deliveryFormat).toBe("markdown");
      const heartbeat = requireRecord(options.heartbeat, "heartbeat override");
      expect(heartbeat).toEqual({
        target: "last",
        deliveryFormat: "markdown",
        to: undefined,
        accountId: undefined,
      });
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
