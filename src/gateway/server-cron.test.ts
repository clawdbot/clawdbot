import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CliDeps } from "../cli/deps.js";
import type { OpenClawConfig } from "../config/config.js";
import { SsrFBlockedError } from "../infra/net/ssrf.js";

const {
  enqueueSystemEventMock,
  requestHeartbeatMock,
  runHeartbeatOnceMock,
  loadConfigMock,
  fetchWithSsrFGuardMock,
  runCronIsolatedAgentTurnMock,
  cleanupBrowserSessionsForLifecycleEndMock,
  getGlobalHookRunnerMock,
  runCronChangedMock,
} = vi.hoisted(() => ({
  enqueueSystemEventMock: vi.fn(),
  requestHeartbeatMock: vi.fn(),
  runHeartbeatOnceMock: vi.fn<
    (...args: unknown[]) => Promise<{ status: "ran"; durationMs: number }>
  >(async () => ({ status: "ran", durationMs: 1 })),
  loadConfigMock: vi.fn(),
  fetchWithSsrFGuardMock: vi.fn(),
  runCronIsolatedAgentTurnMock: vi.fn(async () => ({ status: "ok" as const, summary: "ok" })),
  cleanupBrowserSessionsForLifecycleEndMock: vi.fn(async () => {}),
  runCronChangedMock: vi.fn(async () => {}),
  getGlobalHookRunnerMock: vi.fn(() => ({
    hasHooks: (hookName: string) => hookName === "cron_changed",
    runCronChanged: runCronChangedMock,
  })),
}));

function enqueueSystemEvent(...args: unknown[]) {
  return enqueueSystemEventMock(...args);
}

function requestHeartbeat(...args: unknown[]) {
  return requestHeartbeatMock(...args);
}

function runHeartbeatOnce(...args: unknown[]) {
  return runHeartbeatOnceMock(...args);
}

vi.mock("../infra/system-events.js", () => ({
  enqueueSystemEvent,
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

vi.mock("../cron/isolated-agent.js", () => ({
  runCronIsolatedAgentTurn: runCronIsolatedAgentTurnMock,
}));

vi.mock("../browser-lifecycle-cleanup.js", () => ({
  cleanupBrowserSessionsForLifecycleEnd: cleanupBrowserSessionsForLifecycleEndMock,
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: getGlobalHookRunnerMock,
}));

import { buildGatewayCronService } from "./server-cron.js";

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
  const call = mock.mock.calls.at(callIndex);
  if (!call) {
    throw new Error(`Expected mock call: ${label}`);
  }
  if (argIndex >= call.length) {
    throw new Error(`Expected mock call argument ${argIndex}: ${label}`);
  }
  return call[argIndex];
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
    requestHeartbeatMock.mockClear();
    runHeartbeatOnceMock.mockClear();
    loadConfigMock.mockClear();
    fetchWithSsrFGuardMock.mockClear();
    runCronIsolatedAgentTurnMock.mockClear();
    cleanupBrowserSessionsForLifecycleEndMock.mockClear();
    runCronChangedMock.mockClear();
    getGlobalHookRunnerMock.mockClear();
    getGlobalHookRunnerMock.mockReturnValue({
      hasHooks: (hookName: string) => hookName === "cron_changed",
      runCronChanged: runCronChangedMock,
    });
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
      expect(
        requireRecord(callArg(enqueueSystemEventMock, 0, 1, "system event options"), "options")
          .sessionKey,
      ).toBe("agent:main:discord:channel:ops");
      expect(
        requireRecord(callArg(requestHeartbeatMock, 0, 0, "heartbeat request"), "request")
          .sessionKey,
      ).toBe("agent:main:discord:channel:ops");
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
      expect(call.sessionKey).toBe("agent:main:telegram:group:123:topic:456");
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
      const enqueueCall = enqueueSystemEventMock.mock.calls.at(-1);
      const wakeCall = requestHeartbeatMock.mock.calls.at(-1);
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

      const enqueueCall = enqueueSystemEventMock.mock.calls.at(-1);
      const wakeCall = requestHeartbeatMock.mock.calls.at(-1);
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

      const enqueueCall = enqueueSystemEventMock.mock.calls.at(-1);
      const wakeCall = requestHeartbeatMock.mock.calls.at(-1);
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

      const enqueueCall = enqueueSystemEventMock.mock.calls.at(-1);
      const wakeCall = requestHeartbeatMock.mock.calls.at(-1);
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

  it("preserves trust downgrades when cron enqueues system events", () => {
    const cfg = createCronConfig("server-cron-untrusted");
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
                  trusted?: boolean;
                },
              ) => void;
            };
          };
        }
      ).state?.deps;

      cronDeps?.enqueueSystemEvent?.("hello", {
        sessionKey: "discord:channel:ops",
        contextKey: "cron:test",
        trusted: false,
      });

      expect(enqueueSystemEventMock).toHaveBeenCalledWith("hello", {
        sessionKey: "agent:main:discord:channel:ops",
        contextKey: "cron:test",
        trusted: false,
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

  it("passes custom session targets through to isolated cron runs", async () => {
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
      const job = await state.cron.add({
        name: "custom-session",
        enabled: true,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "session:project-alpha-monitor",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "hello" },
      });

      await state.cron.run(job.id, "force");

      const options = expectIsolatedRunFields({ sessionKey: "project-alpha-monitor" });
      expect(requireRecord(options.job, "isolated job").id).toBe(job.id);
      expectCleanupForSessionKeys(["project-alpha-monitor"]);
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
