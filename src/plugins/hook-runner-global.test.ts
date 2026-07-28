/** Verifies global hook runner sequencing, mutation, and error behavior. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockPluginRegistry } from "./hooks.test-fixtures.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import {
  pinActivePluginChannelRegistry,
  releasePinnedPluginChannelRegistry,
  setActivePluginRegistry,
} from "./runtime.js";
import { createPluginRecord } from "./status.test-fixtures.js";

async function importHookRunnerGlobalModule() {
  return import("./hook-runner-global.js");
}

async function importHookRunnerGlobalStateModule() {
  return import("./hook-runner-global-state.js");
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
  const mod = await importHookRunnerGlobalModule();
  mod.resetGlobalHookRunner();
  setActivePluginRegistry(createEmptyPluginRegistry());
});

describe("hook-runner-global", () => {
  async function createInitializedModule() {
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

  it("exposes trusted policies from the same live registry set as hooks", async () => {
    const mod = await importHookRunnerGlobalModule();
    const gatewayRegistry = createMockPluginRegistry([
      {
        hookName: "before_tool_call",
        pluginId: "rovoclaw",
        handler: vi.fn(),
      },
    ]);
    gatewayRegistry.plugins = [createPluginRecord({ id: "rovoclaw" })];
    gatewayRegistry.trustedToolPolicies = [
      {
        pluginId: "rovoclaw",
        pluginName: "RovoClaw",
        source: "test",
        policy: {
          id: "atl-sec-core",
          description: "trusted policy",
          evaluate: () => undefined,
        },
      },
    ];

    setActivePluginRegistry(gatewayRegistry);
    mod.initializeGlobalHookRunner(gatewayRegistry);
    pinActivePluginChannelRegistry(gatewayRegistry);
    try {
      const laterRegistry = createEmptyPluginRegistry();
      laterRegistry.plugins = [createPluginRecord({ id: "openai" })];
      setActivePluginRegistry(laterRegistry);
      mod.initializeGlobalHookRunner(laterRegistry);

      expect(expectGlobalHookRunner(mod.getGlobalHookRunner()).hasHooks("before_tool_call")).toBe(
        true,
      );
      expect(mod.getGlobalPluginRegistry()).toBe(laterRegistry);
      const stateMod = await importHookRunnerGlobalStateModule();
      expect(
        stateMod
          .getGlobalHookRunnerRegistry()
          ?.trustedToolPolicies?.map((registration) => [
            registration.pluginId,
            registration.policy.id,
          ]),
      ).toEqual([["rovoclaw", "atl-sec-core"]]);
    } finally {
      releasePinnedPluginChannelRegistry(gatewayRegistry);
    }
  });
});
