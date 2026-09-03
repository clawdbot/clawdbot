/** Verifies global hook runner sequencing, mutation, and error behavior. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockPluginRegistry } from "./hooks.test-fixtures.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "./runtime.js";

async function importHookRunnerGlobalModule() {
  return import("./hook-runner-global.js");
}

type HookRunnerGlobalModule = Awaited<ReturnType<typeof importHookRunnerGlobalModule>>;
type HookRunner = NonNullable<ReturnType<HookRunnerGlobalModule["getGlobalHookRunner"]>>;

function expectGlobalHookRunner(
  runner: ReturnType<HookRunnerGlobalModule["getGlobalHookRunner"]>,
): HookRunner {
  if (runner === null) {
    throw new Error("Expected global hook runner");
  }
  expect(typeof runner.hasHooks).toBe("function");
  return runner;
}

async function expectGlobalRunnerState(expected: { hasRunner: boolean; registry?: unknown }) {
  const mod = await importHookRunnerGlobalModule();
  expect(mod.getGlobalHookRunner() === null).toBe(!expected.hasRunner);
  if ("registry" in expected) {
    expect(mod.getGlobalPluginRegistry()).toBe(expected.registry ?? null);
  }
  return mod;
}

afterEach(async () => {
  vi.useRealTimers();
  const mod = await importHookRunnerGlobalModule();
  mod.resetGlobalHookRunner();
  resetPluginRuntimeStateForTest();
});

describe("hook-runner-global", () => {
  async function createInitializedModule() {
    resetPluginRuntimeStateForTest();
    const modA = await importHookRunnerGlobalModule();
    const registry = createMockPluginRegistry([{ hookName: "message_received", handler: vi.fn() }]);
    modA.initializeGlobalHookRunner(registry);
    return { modA, registry };
  }

  it("preserves the initialized runner across module reloads", async () => {
    const { modA, registry } = await createInitializedModule();
    expect(expectGlobalHookRunner(modA.getGlobalHookRunner()).hasHooks("message_received")).toBe(
      true,
    );

    vi.resetModules();

    const modB = await expectGlobalRunnerState({ hasRunner: true, registry });
    expect(expectGlobalHookRunner(modB.getGlobalHookRunner()).hasHooks("message_received")).toBe(
      true,
    );
  });

  it("clears the shared state across module reloads", async () => {
    await createInitializedModule();

    vi.resetModules();

    const modB = await expectGlobalRunnerState({ hasRunner: true });
    modB.resetGlobalHookRunner();
    expect(modB.getGlobalHookRunner()).toBeNull();
    expect(modB.getGlobalPluginRegistry()).toBeNull();

    vi.resetModules();

    await expectGlobalRunnerState({ hasRunner: false });
  });

  it("checks scoped reply dispatch with only the host dispatch kind", async () => {
    const registry = createMockPluginRegistry([]);
    registry.typedHooks.push({
      pluginId: "acp-dispatch",
      hookName: "reply_dispatch",
      handler: vi.fn(),
      eligibleDispatchKinds: ["acp"],
      source: "test",
    });
    const mod = await importHookRunnerGlobalModule();
    setActivePluginRegistry(registry);
    mod.initializeGlobalHookRunner(registry);

    expect(mod.hasGlobalHooks("reply_dispatch", { dispatchKind: "agent" })).toBe(false);
    expect(mod.hasGlobalHooks("reply_dispatch", { dispatchKind: "acp" })).toBe(true);
    expect(mod.hasGlobalHooks("reply_dispatch", {})).toBe(true);
    expect(mod.hasGlobalHooks("reply_dispatch")).toBe(true);
  });

  it.each([
    {
      hookName: "before_tool_call" as const,
      run: (runner: HookRunner) =>
        runner.runBeforeToolCall({ toolName: "read", params: {} }, { toolName: "read" }),
    },
    {
      hookName: "before_install" as const,
      run: (runner: HookRunner) =>
        runner.runBeforeInstall(
          {
            targetName: "demo",
            targetType: "plugin",
            sourcePath: "/tmp/demo",
            sourcePathKind: "directory",
            origin: "local",
            request: { kind: "plugin-dir", mode: "install" },
            builtinScan: {
              status: "ok",
              scannedFiles: 0,
              critical: 0,
              warn: 0,
              info: 0,
              findings: [],
            },
          },
          { origin: "local", targetType: "plugin", requestKind: "plugin-dir" },
        ),
    },
  ])("fails closed when a default-bounded $hookName handler hangs", async ({ hookName, run }) => {
    vi.useFakeTimers();
    let releaseHandler: (() => void) | undefined;
    const registry = createMockPluginRegistry([
      {
        hookName,
        pluginId: "hanging-policy",
        handler: () =>
          new Promise<void>((resolve) => {
            releaseHandler = resolve;
          }),
      },
    ]);
    const mod = await importHookRunnerGlobalModule();
    setActivePluginRegistry(registry);
    mod.initializeGlobalHookRunner(registry);
    const pending = run(expectGlobalHookRunner(mod.getGlobalHookRunner()));

    try {
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      const rejection = expect(pending).rejects.toThrow(
        `${hookName} handler from hanging-policy failed: timed out after 15000ms`,
      );
      await vi.advanceTimersByTimeAsync(15_000);
      await rejection;
    } finally {
      releaseHandler?.();
      await pending.catch(() => undefined);
    }
  });

  it("bounds gateway_stop handlers and lets shutdown continue", async () => {
    vi.useFakeTimers();
    let releaseHandler: (() => void) | undefined;
    const registry = createMockPluginRegistry([
      {
        hookName: "gateway_stop",
        pluginId: "hanging-shutdown",
        handler: () =>
          new Promise<void>((resolve) => {
            releaseHandler = resolve;
          }),
      },
    ]);
    const mod = await importHookRunnerGlobalModule();
    setActivePluginRegistry(registry);
    mod.initializeGlobalHookRunner(registry);
    const pending = mod.runGlobalGatewayStopSafely({
      event: { reason: "test shutdown" },
      ctx: {},
    });

    try {
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toBeUndefined();
    } finally {
      releaseHandler?.();
      await pending;
    }
  });
});
