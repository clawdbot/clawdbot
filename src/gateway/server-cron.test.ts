import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CliDeps } from "../cli/deps.js";
import type { OpenClawConfig } from "../config/config.js";
import { SsrFBlockedError } from "../infra/net/ssrf.js";
import { mergeMockedModule } from "../test-utils/vitest-module-mocks.js";

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
  return await mergeMockedModule(
    await vi.importActual<typeof import("../infra/heartbeat-wake.js")>(
      "../infra/heartbeat-wake.js",
    ),
    () => ({
      requestHeartbeat,
    }),
  );
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

      expect(runCronChangedMock).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "added",
          jobId: job.id,
          sessionTarget: "main",
          job: expect.objectContaining({
            id: job.id,
            sessionTarget: "main",
            state: expect.objectContaining({ nextRunAtMs: job.state.nextRunAtMs }),
          }),
        }),
        expect.objectContaining({
          config: cfg,
          getCron: expect.any(Function),
        }),
      );
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

      expect(runCronChangedMock).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "removed",
          jobId: job.id,
          sessionTarget: "main",
          job: expect.objectContaining({
            id: job.id,
            name: "to-be-removed",
            sessionTarget: "main",
          }),
        }),
        expect.objectContaining({
          getCron: expect.any(Function),
        }),
      );
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

      expect(runCronChangedMock).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "added",
          jobId: job.id,
          sessionTarget: "session:project-alpha",
          agentId: "yinze",
          job: expect.objectContaining({
            id: job.id,
            agentId: "yinze",
            sessionTarget: "session:project-alpha",
          }),
        }),
        expect.objectContaining({
          config: cfg,
        }),
      );
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

      expect(enqueueSystemEventMock).toHaveBeenCalledWith(
        "hello",
        expect.objectContaining({
          sessionKey: "agent:main:discord:channel:ops",
        }),
      );
      expect(requestHeartbeatMock).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "agent:main:discord:channel:ops",
        }),
      );
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
        heartbeat: { target: "last" },
      });
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
      expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith({
        url: "http://127.0.0.1:8080/cron-finished",
        init: {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: expect.stringContaining('"action":"finished"'),
          signal: expect.any(AbortSignal),
        },
      });
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

      expect(runCronIsolatedAgentTurnMock).toHaveBeenCalledWith(
        expect.objectContaining({
          job: expect.objectContaining({ id: job.id }),
          sessionKey: "project-alpha-monitor",
        }),
      );
      expect(cleanupBrowserSessionsForLifecycleEndMock).toHaveBeenCalledWith({
        sessionKeys: ["project-alpha-monitor"],
        onWarn: expect.any(Function),
      });
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

      expect(runCronIsolatedAgentTurnMock).toHaveBeenCalledWith(
        expect.objectContaining({
          job: expect.objectContaining({ id: job.id }),
          sessionKey: `cron:${job.id}`,
        }),
      );
      expect(runCronIsolatedAgentTurnMock).not.toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "main",
        }),
      );
      expect(cleanupBrowserSessionsForLifecycleEndMock).toHaveBeenCalledWith({
        sessionKeys: [`cron:${job.id}`],
        onWarn: expect.any(Function),
      });
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

      expect(runCronIsolatedAgentTurnMock).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "yinze",
          cfg: expect.objectContaining({
            agents: expect.objectContaining({
              list: expect.arrayContaining([
                expect.objectContaining({
                  id: "yinze",
                  workspace: path.join(tmpDir, "workspace-yinze"),
                }),
              ]),
            }),
          }),
        }),
      );
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

      expect(runHeartbeatOnceMock).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "yinze",
          cfg: expect.objectContaining({
            agents: expect.objectContaining({
              list: expect.arrayContaining([
                expect.objectContaining({
                  id: "yinze",
                  heartbeat: expect.objectContaining({
                    target: "last",
                    deliveryFormat: "markdown",
                  }),
                }),
              ]),
            }),
          }),
          heartbeat: expect.objectContaining({
            target: "last",
            deliveryFormat: "markdown",
          }),
        }),
      );
    } finally {
      state.cron.stop();
    }
  });
});
