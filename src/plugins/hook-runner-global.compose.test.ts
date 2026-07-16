/**
 * Composition rules for the global hook runner's live registry view (#91918).
 * These exercise the ownership/precedence/liveness decisions directly with
 * mock registries, complementing the real-load kill-chain coverage in
 * loader.hook-runner-live-view.test.ts.
 */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getGlobalHookRunnerRegistry } from "./hook-runner-global-state.js";
import {
  getGlobalHookRunner,
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "./hook-runner-global.js";
import { addTestHook, createMockPluginRegistry } from "./hooks.test-fixtures.js";
import type { PluginRegistry } from "./registry.js";
import {
  pinActivePluginChannelRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "./runtime.js";
import { createPluginRecord } from "./status.test-fixtures.js";

function runner() {
  const value = getGlobalHookRunner();
  if (!value) {
    throw new Error("Expected global hook runner");
  }
  return value;
}

function addToolOwner(registry: PluginRegistry, pluginId: string, toolName: string) {
  registry.tools.push({
    pluginId,
    factory: () => [],
    names: [toolName],
    declaredNames: [toolName],
    optional: false,
    source: "test",
  });
}

afterEach(() => {
  resetGlobalHookRunner();
  resetPluginRuntimeStateForTest();
});

describe("global hook runner composition (#91918, #107933)", () => {
  it("uses the pinned gateway owner when the active registry has the same plugin", async () => {
    const gatewayHook = vi.fn();
    const activeHook = vi.fn();
    const gateway = createMockPluginRegistry([
      { hookName: "before_tool_call", handler: gatewayHook, pluginId: "stateful" },
    ]);
    const active = createMockPluginRegistry([
      { hookName: "before_tool_call", handler: activeHook, pluginId: "stateful" },
    ]);
    addToolOwner(gateway, "stateful", "stateful_tool");
    addToolOwner(active, "stateful", "stateful_tool");

    setActivePluginRegistry(gateway);
    pinActivePluginChannelRegistry(gateway);
    initializeGlobalHookRunner(gateway);
    setActivePluginRegistry(active);
    initializeGlobalHookRunner(active);

    await runner().runBeforeToolCall(
      { toolName: "stateful_tool", params: {} },
      {
        agentId: "test-agent",
        sessionKey: "test-session",
        toolCallId: "test-call",
        toolName: "stateful_tool",
      },
    );

    // Plugin tools resolve from the pinned channel registry before the active
    // registry. Hooks for that plugin must use the same registration closure.
    expect(gatewayHook).toHaveBeenCalledOnce();
    expect(activeHook).not.toHaveBeenCalled();
  });

  it("uses the active hook when the pinned registry has no matching tool owner", async () => {
    const gatewayHook = vi.fn();
    const activeHook = vi.fn();
    const gateway = createMockPluginRegistry([
      { hookName: "before_tool_call", handler: gatewayHook, pluginId: "conditional" },
    ]);
    const active = createMockPluginRegistry([
      { hookName: "before_tool_call", handler: activeHook, pluginId: "conditional" },
    ]);
    addToolOwner(active, "conditional", "conditional_tool");

    setActivePluginRegistry(gateway);
    pinActivePluginChannelRegistry(gateway);
    initializeGlobalHookRunner(gateway);
    setActivePluginRegistry(active);
    initializeGlobalHookRunner(active);

    await runner().runBeforeToolCall(
      { toolName: "conditional_tool", params: {} },
      {
        agentId: "test-agent",
        sessionKey: "test-session",
        toolCallId: "test-call",
        toolName: "conditional_tool",
      },
    );

    expect(activeHook).toHaveBeenCalledOnce();
    expect(gatewayHook).not.toHaveBeenCalled();
  });

  it("does not borrow a pinned hook when the active tool owner registered none", () => {
    const gateway = createMockPluginRegistry([
      { hookName: "before_tool_call", handler: vi.fn(), pluginId: "conditional" },
    ]);
    const active = createMockPluginRegistry([]);
    expectDefined(active.plugins[0], "active.plugins[0] test invariant").id = "conditional";
    addToolOwner(active, "conditional", "conditional_tool");

    setActivePluginRegistry(gateway);
    pinActivePluginChannelRegistry(gateway);
    initializeGlobalHookRunner(gateway);
    setActivePluginRegistry(active);
    initializeGlobalHookRunner(active);

    expect(runner().hasHooks("before_tool_call")).toBe(false);
  });

  it("prefers a loaded registration over a failed scoped reload of the same plugin", () => {
    const boot = createMockPluginRegistry([
      { hookName: "before_tool_call", handler: vi.fn(), pluginId: "gate" },
    ]);
    // Scoped reload where the gate plugin failed to register: record present,
    // status not loaded, no hooks.
    const scopedFailure = createMockPluginRegistry([]);
    expectDefined(scopedFailure.plugins[0], "scopedFailure.plugins[0] test invariant").id = "gate";
    expectDefined(scopedFailure.plugins[0], "scopedFailure.plugins[0] test invariant").status =
      "error";

    setActivePluginRegistry(boot);
    pinActivePluginChannelRegistry(boot);
    initializeGlobalHookRunner(boot);
    expect(runner().hasHooks("before_tool_call")).toBe(true);

    setActivePluginRegistry(scopedFailure);
    initializeGlobalHookRunner(scopedFailure);
    // The pinned boot registry still owns the loaded gate, so the fail-closed
    // tool-call hook is not shadowed by the errored scoped record.
    expect(runner().hasHooks("before_tool_call")).toBe(true);
  });

  it("prefers a loaded source that carries the hook over a loaded-but-hookless record", () => {
    // Pinned boot registry: plugin C loaded WITH a fail-closed tool-call gate.
    const boot = createMockPluginRegistry([
      { hookName: "before_tool_call", handler: vi.fn(), pluginId: "C" },
    ]);
    // Scoped reload where C is present and loaded but registered no hooks
    // (e.g. a setup-runtime channel load registers the channel, not api.on).
    const scopedHookless = createMockPluginRegistry([]);
    expectDefined(scopedHookless.plugins[0], "scopedHookless.plugins[0] test invariant").id = "C";
    expectDefined(scopedHookless.plugins[0], "scopedHookless.plugins[0] test invariant").status =
      "loaded";

    pinActivePluginChannelRegistry(boot);
    setActivePluginRegistry(scopedHookless);
    initializeGlobalHookRunner(scopedHookless);
    // The hookless scoped record is highest precedence but must not shadow the
    // pinned registration that actually carries C's gate.
    expect(runner().hasHooks("before_tool_call")).toBe(true);
  });

  it("keeps a pinned registry with zero channels visible to hook dispatch", () => {
    const hookOnlyPinned = createMockPluginRegistry([
      { hookName: "subagent_ended", handler: vi.fn(), pluginId: "hooky" },
    ]);
    const channelActive = createMockPluginRegistry([
      { hookName: "message_sent", handler: vi.fn(), pluginId: "chan" },
    ]);
    // Give the active registry a channel so the channel-presentation selector
    // would prefer it and evict the zero-channel pinned registry — the raw
    // live-registry collector must keep the pinned one regardless.
    (channelActive.channels as unknown[]).push({});

    setActivePluginRegistry(channelActive);
    pinActivePluginChannelRegistry(hookOnlyPinned);
    initializeGlobalHookRunner(channelActive);

    expect(runner().hasHooks("subagent_ended")).toBe(true);
    expect(runner().hasHooks("message_sent")).toBe(true);
  });

  it("keeps bundled trusted policies before installed policies across live registries", () => {
    const pinnedBundled = createMockPluginRegistry([
      { hookName: "before_tool_call", handler: vi.fn(), pluginId: "bundled-policy" },
    ]);
    pinnedBundled.plugins = [createPluginRecord({ id: "bundled-policy", origin: "bundled" })];
    pinnedBundled.trustedToolPolicies = [
      {
        pluginId: "bundled-policy",
        pluginName: "Bundled Policy",
        origin: "bundled",
        source: "test",
        policy: {
          id: "bundled-first",
          description: "bundled policy",
          evaluate: () => undefined,
        },
      },
    ];
    const activeInstalled = createMockPluginRegistry([]);
    activeInstalled.plugins = [createPluginRecord({ id: "installed-policy", origin: "workspace" })];
    activeInstalled.trustedToolPolicies = [
      {
        pluginId: "installed-policy",
        pluginName: "Installed Policy",
        origin: "workspace",
        source: "test",
        policy: {
          id: "installed-second",
          description: "installed policy",
          evaluate: () => undefined,
        },
      },
    ];

    pinActivePluginChannelRegistry(pinnedBundled);
    setActivePluginRegistry(activeInstalled);
    initializeGlobalHookRunner(activeInstalled);

    expect(
      getGlobalHookRunnerRegistry()?.trustedToolPolicies?.map((registration) => [
        registration.origin,
        registration.policy.id,
      ]),
    ).toEqual([
      ["bundled", "bundled-first"],
      ["workspace", "installed-second"],
    ]);
  });

  it("lets an explicitly initialized registry win ownership over the active registry", () => {
    const activeRegistry = createMockPluginRegistry([
      { hookName: "message_received", handler: vi.fn(), pluginId: "foo" },
    ]);
    const sdkRegistry = createMockPluginRegistry([
      { hookName: "message_sent", handler: vi.fn(), pluginId: "foo" },
    ]);

    setActivePluginRegistry(activeRegistry);
    initializeGlobalHookRunner(sdkRegistry);

    // Last-initialized highest precedence: the SDK registry owns plugin "foo",
    // so its hook dispatches and the active registry's "foo" hook is shadowed.
    expect(runner().hasHooks("message_sent")).toBe(true);
    expect(runner().hasHooks("message_received")).toBe(false);
  });

  it("dispatches hooks pushed into a registry after initialization", () => {
    const registry: PluginRegistry = createMockPluginRegistry([
      { hookName: "message_received", handler: vi.fn(), pluginId: "p" },
    ]);

    setActivePluginRegistry(registry);
    initializeGlobalHookRunner(registry);
    // Read once so any internal caching would have settled.
    expect(runner().hasHooks("message_received")).toBe(true);
    expect(runner().hasHooks("message_sent")).toBe(false);

    addTestHook({ registry, pluginId: "p", hookName: "message_sent", handler: vi.fn() });
    // Live composition: the late registration is visible without re-init.
    expect(runner().hasHooks("message_sent")).toBe(true);
  });
});
