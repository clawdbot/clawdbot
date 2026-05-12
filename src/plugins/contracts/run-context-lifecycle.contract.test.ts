import fs from "node:fs/promises";
import path from "node:path";
import {
  createPluginRegistryFixture,
  registerTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSessionStore, updateSessionStore } from "../../config/sessions.js";
import { withTempConfig } from "../../gateway/test-temp-config.js";
import { emitAgentEvent, resetAgentEventsForTest } from "../../infra/agent-events.js";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import { PLUGIN_HOST_CLEANUP_TIMEOUT_MS } from "../host-hook-cleanup-timeout.js";
import { runPluginHostCleanup } from "../host-hook-cleanup.js";
import {
  clearPluginHostRuntimeState,
  getPluginRunContext,
  listPluginSessionSchedulerJobs,
  PLUGIN_TERMINAL_EVENT_CLEANUP_WAIT_MS,
  dispatchPluginAgentEventSubscriptions,
  registerPluginSessionSchedulerJob,
  setPluginRunContext,
} from "../host-hook-runtime.js";
import { createEmptyPluginRegistry } from "../registry-empty.js";
import { setActivePluginRegistry } from "../runtime.js";
import { createPluginRecord } from "../status.test-helpers.js";
import type { OpenClawPluginApi } from "../types.js";

async function waitForPluginEventHandlers(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function expectNoCleanupFailures(result: Awaited<ReturnType<typeof runPluginHostCleanup>>): void {
  expect(result.failures).toEqual([]);
}

function requireFailureByHookId(
  result: Awaited<ReturnType<typeof runPluginHostCleanup>>,
  hookId: string,
) {
  const failure = result.failures.find((entry) => entry.hookId === hookId);
  if (!failure) {
    throw new Error(`Expected cleanup failure for hook ${hookId}`);
  }
  return failure;
}

describe("plugin run context lifecycle", () => {
  afterEach(() => {
    vi.useRealTimers();
    setActivePluginRegistry(createEmptyPluginRegistry());
    clearPluginHostRuntimeState();
    resetAgentEventsForTest();
  });

  it("blocks stale plugin API run-context mutations after registry replacement", () => {
    const { config, registry } = createPluginRegistryFixture();
    let capturedApi: OpenClawPluginApi | undefined;
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "stale-run-context-plugin",
        name: "Stale Run Context Plugin",
      }),
      register(api) {
        capturedApi = api;
      },
    });
    setActivePluginRegistry(registry.registry);
    setActivePluginRegistry(createEmptyPluginRegistry());

    expect(
      capturedApi?.runContext?.setRunContext({
        runId: "stale-run",
        namespace: "state",
        value: { stale: true },
      }),
    ).toBe(false);
    expect(
      getPluginRunContext({
        pluginId: "stale-run-context-plugin",
        get: { runId: "stale-run", namespace: "state" },
      }),
    ).toBeUndefined();

    expect(
      setPluginRunContext({
        pluginId: "stale-run-context-plugin",
        patch: { runId: "stale-run", namespace: "state", value: { live: true } },
      }),
    ).toBe(true);
    capturedApi?.runContext?.clearRunContext({ runId: "stale-run", namespace: "state" });
    expect(
      getPluginRunContext({
        pluginId: "stale-run-context-plugin",
        get: { runId: "stale-run", namespace: "state" },
      }),
    ).toEqual({ live: true });
  });

  it("allows run-context mutations after a previous registry is restored active", () => {
    const { config, registry } = createPluginRegistryFixture();
    let capturedApi: OpenClawPluginApi | undefined;
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "restored-run-context-plugin",
        name: "Restored Run Context Plugin",
      }),
      register(api) {
        capturedApi = api;
      },
    });
    setActivePluginRegistry(registry.registry);
    setActivePluginRegistry(createEmptyPluginRegistry());
    setActivePluginRegistry(registry.registry);

    expect(
      capturedApi?.runContext?.setRunContext({
        runId: "restored-run",
        namespace: "state",
        value: { restored: true },
      }),
    ).toBe(true);
    expect(
      capturedApi?.runContext?.getRunContext({
        runId: "restored-run",
        namespace: "state",
      }),
    ).toEqual({ restored: true });
  });

  it("allows run-context initialization during activating plugin registration", () => {
    const { config, registry } = createPluginRegistryFixture();
    const api = registry.createApi(
      createPluginRecord({
        id: "registration-run-context-plugin",
        name: "Registration Run Context Plugin",
      }),
      { config },
    );

    expect(
      api.setRunContext({
        runId: "run-registration",
        namespace: "state",
        value: { initialized: true },
      }),
    ).toBe(true);
    expect(
      getPluginRunContext({
        pluginId: "registration-run-context-plugin",
        get: { runId: "run-registration", namespace: "state" },
      }),
    ).toEqual({ initialized: true });

    api.clearRunContext({ runId: "run-registration", namespace: "state" });
    expect(
      getPluginRunContext({
        pluginId: "registration-run-context-plugin",
        get: { runId: "run-registration", namespace: "state" },
      }),
    ).toBeUndefined();
  });

  it("keeps restored active registry state after stale async cleanup finishes", async () => {
    let releaseCleanup: (() => void) | undefined;
    let markCleanupStarted: (() => void) | undefined;
    let capturedApi: OpenClawPluginApi | undefined;
    const cleanupStarted = new Promise<void>((resolve) => {
      markCleanupStarted = resolve;
    });
    const cleanupRelease = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const schedulerCleanup = vi.fn();
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "delayed-restored-registry-plugin",
        name: "Delayed Restored Registry Plugin",
      }),
      register(api) {
        capturedApi = api;
        api.registerRuntimeLifecycle({
          id: "delayed-cleanup",
          async cleanup() {
            markCleanupStarted?.();
            await cleanupRelease;
          },
        });
        api.registerSessionSchedulerJob({
          id: "live-job",
          sessionKey: "agent:main:main",
          kind: "session-turn",
          cleanup: schedulerCleanup,
        });
      },
    });
    setActivePluginRegistry(registry.registry);
    setActivePluginRegistry(createEmptyPluginRegistry());
    await cleanupStarted;
    setActivePluginRegistry(registry.registry);

    expect(
      capturedApi?.setRunContext({
        runId: "restored-after-cleanup-started",
        namespace: "state",
        value: { restored: true },
      }),
    ).toBe(true);

    releaseCleanup?.();
    await waitForPluginEventHandlers();
    await waitForPluginEventHandlers();

    expect(
      getPluginRunContext({
        pluginId: "delayed-restored-registry-plugin",
        get: { runId: "restored-after-cleanup-started", namespace: "state" },
      }),
    ).toEqual({ restored: true });
    expect(schedulerCleanup).not.toHaveBeenCalled();
    expect(listPluginSessionSchedulerJobs("delayed-restored-registry-plugin")).toEqual([
      {
        id: "live-job",
        pluginId: "delayed-restored-registry-plugin",
        sessionKey: "agent:main:main",
        kind: "session-turn",
      },
    ]);
  });

  it("does not let delayed non-terminal subscriptions resurrect closed run context", async () => {
    let releaseToolHandler: (() => void) | undefined;
    let delayedToolHandlerSawContext: unknown;
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "delayed-subscription",
        name: "Delayed Subscription",
      }),
      register(api) {
        api.registerAgentEventSubscription({
          id: "delayed",
          streams: ["tool"],
          async handle(_event, ctx) {
            ctx.setRunContext("before-terminal", { visible: true });
            await new Promise<void>((resolve) => {
              releaseToolHandler = resolve;
            });
            delayedToolHandlerSawContext = ctx.getRunContext("before-terminal");
            ctx.setRunContext("late", { resurrected: true });
          },
        });
      },
    });
    setActivePluginRegistry(registry.registry);

    emitAgentEvent({
      runId: "run-delayed-subscription",
      stream: "tool",
      data: { name: "tool" },
    });
    await Promise.resolve();

    emitAgentEvent({
      runId: "run-delayed-subscription",
      stream: "lifecycle",
      data: { phase: "end" },
    });
    await Promise.resolve();

    expect(
      getPluginRunContext({
        pluginId: "delayed-subscription",
        get: { runId: "run-delayed-subscription", namespace: "before-terminal" },
      }),
    ).toEqual({ visible: true });

    releaseToolHandler?.();
    await waitForPluginEventHandlers();

    expect(delayedToolHandlerSawContext).toEqual({ visible: true });
    expect(
      getPluginRunContext({
        pluginId: "delayed-subscription",
        get: { runId: "run-delayed-subscription", namespace: "late" },
      }),
    ).toBeUndefined();
  });

  it("preserves run context until async terminal event subscriptions settle", async () => {
    let releaseTerminalHandler: (() => void) | undefined;
    let terminalHandlerSawContext: unknown;
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "async-terminal-subscription",
        name: "Async Terminal Subscription",
      }),
      register(api) {
        api.registerAgentEventSubscription({
          id: "records",
          streams: ["tool", "lifecycle"],
          async handle(event, ctx) {
            if (event.stream === "tool") {
              ctx.setRunContext("seen", { runId: event.runId });
              return;
            }
            if (event.data?.phase !== "end") {
              return;
            }
            await new Promise<void>((resolve) => {
              releaseTerminalHandler = resolve;
            });
            terminalHandlerSawContext = ctx.getRunContext("seen");
          },
        });
      },
    });
    setActivePluginRegistry(registry.registry);

    emitAgentEvent({
      runId: "run-async-terminal",
      stream: "tool",
      data: { name: "tool" },
    });
    await Promise.resolve();

    emitAgentEvent({
      runId: "run-async-terminal",
      stream: "lifecycle",
      data: { phase: "end" },
    });
    await Promise.resolve();

    expect(
      getPluginRunContext({
        pluginId: "async-terminal-subscription",
        get: { runId: "run-async-terminal", namespace: "seen" },
      }),
    ).toEqual({ runId: "run-async-terminal" });

    releaseTerminalHandler?.();
    await waitForPluginEventHandlers();

    expect(terminalHandlerSawContext).toEqual({ runId: "run-async-terminal" });
    expect(
      getPluginRunContext({
        pluginId: "async-terminal-subscription",
        get: { runId: "run-async-terminal", namespace: "seen" },
      }),
    ).toBeUndefined();
  });

  it("waits for terminal handlers added after the first terminal cleanup waiter starts", async () => {
    let releaseFirstTerminalHandler: (() => void) | undefined;
    let releaseSecondTerminalHandler: (() => void) | undefined;
    let firstTerminalHandlerSawContext: unknown;
    let secondTerminalHandlerSawContext: unknown;
    let terminalEventsSeen = 0;
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "repeated-terminal-live-wait",
        name: "Repeated Terminal Live Wait",
      }),
      register(api) {
        api.registerAgentEventSubscription({
          id: "records",
          streams: ["tool", "lifecycle"],
          async handle(event, ctx) {
            if (event.stream === "tool") {
              ctx.setRunContext("seen", { runId: event.runId });
              return;
            }
            if (event.data?.phase !== "end") {
              return;
            }
            terminalEventsSeen += 1;
            if (terminalEventsSeen === 1) {
              await new Promise<void>((resolve) => {
                releaseFirstTerminalHandler = resolve;
              });
              firstTerminalHandlerSawContext = ctx.getRunContext("seen");
              return;
            }
            await new Promise<void>((resolve) => {
              releaseSecondTerminalHandler = resolve;
            });
            secondTerminalHandlerSawContext = ctx.getRunContext("seen");
          },
        });
      },
    });
    setActivePluginRegistry(registry.registry);

    emitAgentEvent({
      runId: "run-repeated-terminal-live-wait",
      stream: "tool",
      data: { name: "tool" },
    });
    await waitForPluginEventHandlers();

    emitAgentEvent({
      runId: "run-repeated-terminal-live-wait",
      stream: "lifecycle",
      data: { phase: "end" },
    });
    await waitForPluginEventHandlers();

    emitAgentEvent({
      runId: "run-repeated-terminal-live-wait",
      stream: "lifecycle",
      data: { phase: "end" },
    });
    await waitForPluginEventHandlers();

    releaseFirstTerminalHandler?.();
    await waitForPluginEventHandlers();
    expect(firstTerminalHandlerSawContext).toEqual({ runId: "run-repeated-terminal-live-wait" });
    expect(
      getPluginRunContext({
        pluginId: "repeated-terminal-live-wait",
        get: { runId: "run-repeated-terminal-live-wait", namespace: "seen" },
      }),
    ).toEqual({ runId: "run-repeated-terminal-live-wait" });

    releaseSecondTerminalHandler?.();
    await waitForPluginEventHandlers();
    await waitForPluginEventHandlers();

    expect(secondTerminalHandlerSawContext).toEqual({ runId: "run-repeated-terminal-live-wait" });
    expect(
      getPluginRunContext({
        pluginId: "repeated-terminal-live-wait",
        get: { runId: "run-repeated-terminal-live-wait", namespace: "seen" },
      }),
    ).toBeUndefined();
  });

  it("clears run context after the terminal subscription grace period", async () => {
    vi.useFakeTimers();
    let releaseTerminalHandler: (() => void) | undefined;
    let terminalHandlerSawContext: unknown;
    let terminalHandlerWroteContext: unknown;
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "slow-terminal-subscription",
        name: "Slow Terminal Subscription",
      }),
      register(api) {
        api.registerAgentEventSubscription({
          id: "slow",
          streams: ["tool", "lifecycle"],
          async handle(event, ctx) {
            if (event.stream === "tool") {
              ctx.setRunContext("seen", { runId: event.runId });
              return;
            }
            if (event.data?.phase === "end") {
              await new Promise<void>((resolve) => {
                releaseTerminalHandler = resolve;
              });
              terminalHandlerSawContext = ctx.getRunContext("seen");
              ctx.setRunContext("terminal", { completed: true });
              terminalHandlerWroteContext = ctx.getRunContext("terminal");
            }
          },
        });
      },
    });
    setActivePluginRegistry(registry.registry);

    emitAgentEvent({
      runId: "run-slow-terminal",
      stream: "tool",
      data: { name: "tool" },
    });
    await Promise.resolve();

    emitAgentEvent({
      runId: "run-slow-terminal",
      stream: "lifecycle",
      data: { phase: "end" },
    });
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(PLUGIN_TERMINAL_EVENT_CLEANUP_WAIT_MS);
    expect(
      getPluginRunContext({
        pluginId: "slow-terminal-subscription",
        get: { runId: "run-slow-terminal", namespace: "seen" },
      }),
    ).toBeUndefined();

    releaseTerminalHandler?.();
    await vi.advanceTimersByTimeAsync(0);

    expect(terminalHandlerSawContext).toBeUndefined();
    expect(terminalHandlerWroteContext).toBeUndefined();
    expect(
      getPluginRunContext({
        pluginId: "slow-terminal-subscription",
        get: { runId: "run-slow-terminal", namespace: "seen" },
      }),
    ).toBeUndefined();
    expect(
      getPluginRunContext({
        pluginId: "slow-terminal-subscription",
        get: { runId: "run-slow-terminal", namespace: "terminal" },
      }),
    ).toBeUndefined();
  });

  it("keeps the expired terminal marker across repeated terminal events", async () => {
    vi.useFakeTimers();
    let releaseFirstTerminalHandler: (() => void) | undefined;
    let firstTerminalHandlerWroteContext: unknown;
    let secondTerminalHandlerWroteContext: unknown;
    let terminalEventsSeen = 0;
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "repeated-terminal-subscription",
        name: "Repeated Terminal Subscription",
      }),
      register(api) {
        api.registerAgentEventSubscription({
          id: "repeat-terminal",
          streams: ["lifecycle"],
          async handle(event, ctx) {
            if (event.data?.phase !== "end") {
              return;
            }
            terminalEventsSeen += 1;
            if (terminalEventsSeen === 1) {
              await new Promise<void>((resolve) => {
                releaseFirstTerminalHandler = resolve;
              });
              ctx.setRunContext("terminal", { from: "first" });
              firstTerminalHandlerWroteContext = ctx.getRunContext("terminal");
              return;
            }
            ctx.setRunContext("terminal", { from: "second" });
            secondTerminalHandlerWroteContext = ctx.getRunContext("terminal");
          },
        });
      },
    });
    setActivePluginRegistry(registry.registry);

    emitAgentEvent({
      runId: "run-repeat-terminal",
      stream: "lifecycle",
      data: { phase: "end" },
    });
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(PLUGIN_TERMINAL_EVENT_CLEANUP_WAIT_MS);

    emitAgentEvent({
      runId: "run-repeat-terminal",
      stream: "lifecycle",
      data: { phase: "end" },
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(secondTerminalHandlerWroteContext).toBeUndefined();
    expect(
      getPluginRunContext({
        pluginId: "repeated-terminal-subscription",
        get: { runId: "run-repeat-terminal", namespace: "terminal" },
      }),
    ).toBeUndefined();

    releaseFirstTerminalHandler?.();
    await vi.advanceTimersByTimeAsync(0);

    expect(firstTerminalHandlerWroteContext).toBeUndefined();
    expect(
      getPluginRunContext({
        pluginId: "repeated-terminal-subscription",
        get: { runId: "run-repeat-terminal", namespace: "terminal" },
      }),
    ).toBeUndefined();
  });

  it("preserves scheduler jobs instead of invoking stale cleanup callbacks", async () => {
    const cleanup = vi.fn();
    registerPluginSessionSchedulerJob({
      pluginId: "scheduler-plugin",
      pluginName: "Scheduler Plugin",
      job: {
        id: "job-preserved",
        sessionKey: "agent:main:main",
        kind: "session-turn",
        cleanup,
      },
    });

    expectNoCleanupFailures(
      await runPluginHostCleanup({
        reason: "disable",
        pluginId: "scheduler-plugin",
        preserveSchedulerJobIds: new Set(["job-preserved"]),
      }),
    );
    expect(cleanup).not.toHaveBeenCalled();
    expect(listPluginSessionSchedulerJobs("scheduler-plugin")).toHaveLength(1);
  });

  it("preserves plugin run context during restart cleanup", async () => {
    const registry = createEmptyPluginRegistry();
    expect(
      setPluginRunContext({
        pluginId: "restart-context-plugin",
        patch: { runId: "run-restart", namespace: "state", value: { keep: true } },
      }),
    ).toBe(true);

    expectNoCleanupFailures(
      await runPluginHostCleanup({
        registry,
        pluginId: "restart-context-plugin",
        reason: "restart",
      }),
    );
    expect(
      getPluginRunContext({
        pluginId: "restart-context-plugin",
        get: { runId: "run-restart", namespace: "state" },
      }),
    ).toEqual({ keep: true });

    expectNoCleanupFailures(
      await runPluginHostCleanup({
        registry,
        pluginId: "restart-context-plugin",
        reason: "disable",
      }),
    );
    expect(
      getPluginRunContext({
        pluginId: "restart-context-plugin",
        get: { runId: "run-restart", namespace: "state" },
      }),
    ).toBeUndefined();
  });

  it("preserves durable plugin session state during plugin restart cleanup", async () => {
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "restart-state-fixture",
        name: "Restart State Fixture",
      }),
      register(api) {
        api.registerSessionExtension({
          namespace: "workflow",
          description: "restart state test",
        });
      },
    });

    const stateDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-run-context-restart-state-"),
    );
    const storePath = path.join(stateDir, "sessions.json");
    const tempConfig = {
      session: { store: storePath },
    };
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    try {
      process.env.OPENCLAW_STATE_DIR = stateDir;
      await withTempConfig({
        cfg: tempConfig,
        run: async () => {
          await updateSessionStore(storePath, (store) => {
            store["agent:main:main"] = {
              sessionId: "session-1",
              updatedAt: Date.now(),
              pluginExtensions: {
                "restart-state-fixture": { workflow: { state: "waiting" } },
              },
              pluginNextTurnInjections: {
                "restart-state-fixture": [
                  {
                    id: "resume",
                    pluginId: "restart-state-fixture",
                    text: "resume",
                    placement: "prepend_context",
                    createdAt: 1,
                  },
                ],
              },
            };
            return undefined;
          });

          expectNoCleanupFailures(
            await runPluginHostCleanup({
              cfg: tempConfig,
              registry: registry.registry,
              pluginId: "restart-state-fixture",
              reason: "restart",
            }),
          );

          const stored = loadSessionStore(storePath, { skipCache: true });
          expect(stored["agent:main:main"]?.pluginExtensions).toEqual({
            "restart-state-fixture": { workflow: { state: "waiting" } },
          });
          expect(stored["agent:main:main"]?.pluginNextTurnInjections).toEqual({
            "restart-state-fixture": [
              {
                id: "resume",
                pluginId: "restart-state-fixture",
                text: "resume",
                placement: "prepend_context",
                createdAt: 1,
              },
            ],
          });
        },
      });
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects hung cleanup hooks with a bounded timeout", async () => {
    vi.useFakeTimers();
    const cleanup = vi.fn(async () => {
      await new Promise(() => undefined);
    });
    registerPluginSessionSchedulerJob({
      pluginId: "hung-cleanup-plugin",
      pluginName: "Hung Cleanup Plugin",
      job: {
        id: "job-hung",
        sessionKey: "agent:main:main",
        kind: "session-turn",
        cleanup,
      },
    });

    const resultPromise = runPluginHostCleanup({
      reason: "disable",
      pluginId: "hung-cleanup-plugin",
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(cleanup).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(PLUGIN_HOST_CLEANUP_TIMEOUT_MS);
    const result = await resultPromise;
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.pluginId).toBe("hung-cleanup-plugin");
    expect(result.failures[0]?.hookId).toBe("scheduler:job-hung");
  });

  it("bounds session, runtime, and scheduler cleanup callbacks so cleanup keeps moving", async () => {
    vi.useFakeTimers();
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "hanging-cleanup-fixture",
        name: "Hanging Cleanup Fixture",
      }),
      register(api) {
        api.registerSessionExtension({
          namespace: "state",
          description: "hangs during cleanup",
          cleanup: () => new Promise(() => undefined),
        });
        api.registerRuntimeLifecycle({
          id: "runtime-cleanup",
          cleanup: () => new Promise(() => undefined),
        });
        api.registerSessionSchedulerJob({
          id: "scheduler-cleanup",
          sessionKey: "agent:main:main",
          kind: "monitor",
          cleanup: () => new Promise(() => undefined),
        });
      },
    });

    const cleanupPromise = runPluginHostCleanup({
      cfg: config,
      registry: registry.registry,
      pluginId: "hanging-cleanup-fixture",
      reason: "delete",
    });
    for (let index = 0; index < 3; index += 1) {
      await vi.advanceTimersByTimeAsync(PLUGIN_HOST_CLEANUP_TIMEOUT_MS + 1);
    }
    const result = await cleanupPromise;
    expect(result.failures).toHaveLength(3);
    for (const hookId of [
      "session:state",
      "runtime:runtime-cleanup",
      "scheduler:scheduler-cleanup",
    ]) {
      const failure = requireFailureByHookId(result, hookId);
      expect(failure?.pluginId).toBe("hanging-cleanup-fixture");
    }
  });

  it("blocks setting run context after a run is closed", () => {
    expect(
      setPluginRunContext({
        pluginId: "closed-run-plugin",
        patch: { runId: "run-closed", namespace: "state", value: { before: true } },
      }),
    ).toBe(true);
    dispatchPluginAgentEventSubscriptions({
      registry: createEmptyPluginRegistry(),
      event: {
        runId: "run-closed",
        seq: 1,
        stream: "lifecycle",
        ts: Date.now(),
        data: { phase: "end" },
      },
    });

    expect(
      setPluginRunContext({
        pluginId: "closed-run-plugin",
        patch: { runId: "run-closed", namespace: "state", value: { after: true } },
      }),
    ).toBe(false);
  });
});
