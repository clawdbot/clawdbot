import { afterEach, describe, expect, it, vi } from "vitest";
import { getGlobalHookRunnerRegistry } from "./hook-runner-global-state.js";
import {
  getGlobalHookRunner,
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "./hook-runner-global.js";
import { addTestHook, createMockPluginRegistry } from "./hooks.test-fixtures.js";
import type { PluginRegistry } from "./registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "./runtime.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";
import { createPluginRecord } from "./status.test-helpers.js";

function runner() {
  const value = getGlobalHookRunner();
  if (!value) {
    throw new Error("Expected global hook runner");
  }
  return value;
}

function toolCallContext() {
  return {
    agentId: "test-agent",
    sessionKey: "test-session",
    toolCallId: "test-call",
    toolName: "read",
  };
}

afterEach(() => {
  resetGlobalHookRunner();
  resetPluginRuntimeStateForTest();
});

describe("global hook runner registry selection", () => {
  it("overlays a partial request registry and then returns to the process root", async () => {
    const rootHook = vi.fn();
    const scopedHook = vi.fn();
    const root = createMockPluginRegistry([
      { hookName: "before_tool_call", handler: rootHook, pluginId: "root" },
    ]);
    const scoped = createMockPluginRegistry([
      { hookName: "before_tool_call", handler: scopedHook, pluginId: "scoped" },
    ]);
    root.trustedToolPolicies = [
      {
        pluginId: "root",
        pluginName: "Root",
        source: "test",
        policy: { id: "root-policy", description: "root", evaluate: () => undefined },
      },
    ];
    scoped.trustedToolPolicies = [
      {
        pluginId: "scoped",
        pluginName: "Scoped",
        source: "test",
        policy: { id: "scoped-policy", description: "scoped", evaluate: () => undefined },
      },
    ];

    setActivePluginRegistry(root);
    initializeGlobalHookRunner(root);
    await withPluginRuntimeRegistryScope(scoped, async () => {
      await runner().runBeforeToolCall({ toolName: "read", params: {} }, toolCallContext());
      expect(
        getGlobalHookRunnerRegistry()?.trustedToolPolicies?.map((entry) => entry.policy.id),
      ).toEqual(["root-policy", "scoped-policy"]);
    });

    expect(scopedHook).toHaveBeenCalledOnce();
    expect(rootHook).toHaveBeenCalledOnce();
    await runner().runBeforeToolCall({ toolName: "read", params: {} }, toolCallContext());
    expect(rootHook).toHaveBeenCalledTimes(2);
    expect(
      getGlobalHookRunnerRegistry()?.trustedToolPolicies?.map((entry) => entry.policy.id),
    ).toEqual(["root-policy"]);
  });

  it("lets the request registry replace the same plugin without double dispatch", async () => {
    const rootHook = vi.fn();
    const scopedHook = vi.fn();
    const root = createMockPluginRegistry([
      { hookName: "before_tool_call", handler: rootHook, pluginId: "shared" },
    ]);
    const scoped = createMockPluginRegistry([
      { hookName: "before_tool_call", handler: scopedHook, pluginId: "shared" },
    ]);
    setActivePluginRegistry(root);
    initializeGlobalHookRunner(root);

    await withPluginRuntimeRegistryScope(scoped, () =>
      runner().runBeforeToolCall({ toolName: "read", params: {} }, toolCallContext()),
    );

    expect(scopedHook).toHaveBeenCalledOnce();
    expect(rootHook).not.toHaveBeenCalled();
  });

  it("keeps root contributions when a same-plugin request handle has none", async () => {
    const rootHook = vi.fn();
    const root = createMockPluginRegistry([
      { hookName: "before_tool_call", handler: rootHook, pluginId: "shared" },
    ]);
    root.trustedToolPolicies = [
      {
        pluginId: "shared",
        pluginName: "Shared",
        source: "test",
        policy: { id: "shared-policy", description: "shared", evaluate: () => undefined },
      },
    ];
    const scoped = createMockPluginRegistry([]);
    scoped.plugins = [
      createPluginRecord({ id: "shared", name: "Shared", status: "error", error: "load failed" }),
    ];
    setActivePluginRegistry(root);
    initializeGlobalHookRunner(root);

    await withPluginRuntimeRegistryScope(scoped, async () => {
      await runner().runBeforeToolCall({ toolName: "read", params: {} }, toolCallContext());
      expect(
        getGlobalHookRunnerRegistry()?.trustedToolPolicies?.map((entry) => entry.policy.id),
      ).toEqual(["shared-policy"]);
    });

    expect(rootHook).toHaveBeenCalledOnce();
  });

  it("overlays an explicitly initialized SDK registry on the process root", async () => {
    const rootToolHook = vi.fn();
    const rootWriteHook = vi.fn();
    const sdkWriteHook = vi.fn(() => ({
      message: { role: "user", content: "sdk redaction", timestamp: 2 },
    }));
    const root = createMockPluginRegistry([
      { hookName: "before_tool_call", handler: rootToolHook, pluginId: "shared" },
      { hookName: "before_message_write", handler: rootWriteHook, pluginId: "shared" },
    ]);
    root.trustedToolPolicies = [
      {
        pluginId: "shared",
        pluginName: "Shared",
        source: "test",
        policy: { id: "shared-policy", description: "shared", evaluate: () => undefined },
      },
    ];
    const sdk = createMockPluginRegistry([
      { hookName: "before_message_write", handler: sdkWriteHook, pluginId: "shared" },
    ]);

    setActivePluginRegistry(root);
    initializeGlobalHookRunner(sdk);

    expect(
      runner().runBeforeMessageWrite(
        { message: { role: "user", content: "private", timestamp: 1 } },
        { agentId: "test-agent", sessionKey: "test-session" },
      ),
    ).toEqual({ message: { role: "user", content: "sdk redaction", timestamp: 2 } });
    expect(sdkWriteHook).toHaveBeenCalledOnce();
    expect(rootWriteHook).not.toHaveBeenCalled();

    await runner().runBeforeToolCall({ toolName: "read", params: {} }, toolCallContext());
    expect(rootToolHook).toHaveBeenCalledOnce();
    expect(
      getGlobalHookRunnerRegistry()?.trustedToolPolicies?.map((entry) => entry.policy.id),
    ).toEqual(["shared-policy"]);
  });

  it("sees hooks added after initialization", () => {
    const registry: PluginRegistry = createMockPluginRegistry([
      { hookName: "message_received", handler: vi.fn(), pluginId: "plugin" },
    ]);
    setActivePluginRegistry(registry);
    initializeGlobalHookRunner(registry);

    expect(runner().hasHooks("message_sent")).toBe(false);
    addTestHook({
      registry,
      pluginId: "plugin",
      hookName: "message_sent",
      handler: vi.fn(),
    });
    expect(runner().hasHooks("message_sent")).toBe(true);
  });
});
