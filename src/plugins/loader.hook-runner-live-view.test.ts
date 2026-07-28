/**
 * Regression coverage for #91918: local-extension before_tool_call /
 * after_tool_call hooks must stay dispatchable across the gateway run
 * lifecycle.
 *
 * Mirrors the production sequence that killed them on v2026.6.5:
 *  1. gateway boot: full gateway-bindable load (coreGatewayMethodNames set),
 *     boot registry pinned to the channel/http surfaces
 *  2. harness ensure: scoped default-mode activating load (consumed the old
 *     one-shot preserve gate and flipped active mode to "default")
 *  3. memory ensure: second scoped default-mode activating load (re-initialized
 *     the runner from a memory-only registry, silently dropping tool hooks)
 *
 * With the live composed view, the pinned boot registry keeps the extension's
 * hooks dispatchable no matter how many scoped activations follow.
 */
import { afterEach, describe, expect, it } from "vitest";
import { getGlobalHookRunner, resetGlobalHookRunner } from "./hook-runner-global.js";
import { loadOpenClawPlugins } from "./loader.js";
import {
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "./loader.test-fixtures.js";
import {
  getActivePluginRegistry,
  pinActivePluginChannelRegistry,
  pinActivePluginHttpRouteRegistry,
} from "./runtime.js";

describe("global hook runner live view (#91918)", () => {
  afterEach(() => {
    resetGlobalHookRunner();
    resetPluginLoaderTestStateForTest();
  });

  it("keeps local-extension tool-call hooks dispatchable across scoped default-mode activations", async () => {
    useNoBundledPlugins();
    const gate = writePlugin({
      id: "local-gate",
      filename: "local-gate.cjs",
      body: `module.exports = { id: "local-gate", register(api) {
        api.on("before_tool_call", (event) => {
          if (String(event.params?.command ?? "").includes("curl")) {
            return { block: true, blockReason: "blocked by gate" };
          }
        });
        api.on("after_tool_call", () => undefined);
      } };`,
    });
    const harnessStandIn = writePlugin({
      id: "harness-plugin",
      filename: "harness-plugin.cjs",
      body: `module.exports = { id: "harness-plugin", register() {} };`,
    });
    const memoryStandIn = writePlugin({
      id: "memory-plugin",
      filename: "memory-plugin.cjs",
      body: `module.exports = { id: "memory-plugin", register() {} };`,
    });

    const config = {
      plugins: {
        load: { paths: [gate.file, harnessStandIn.file, memoryStandIn.file] },
        allow: ["local-gate", "harness-plugin", "memory-plugin"],
        entries: {
          "local-gate": { enabled: true },
          "harness-plugin": { enabled: true },
          "memory-plugin": { enabled: true },
        },
      },
    };

    // 1. Gateway boot: full gateway-bindable load, pinned like server.impl.ts.
    const bootRegistry = loadOpenClawPlugins({
      workspaceDir: gate.dir,
      config,
      coreGatewayMethodNames: ["chat.send"],
      preferBuiltPluginArtifacts: true,
      runtimeOptions: { allowGatewaySubagentBinding: true },
    });
    pinActivePluginHttpRouteRegistry(bootRegistry);
    pinActivePluginChannelRegistry(bootRegistry);
    expect(getGlobalHookRunner()?.hasHooks("before_tool_call")).toBe(true);

    // 2. Harness ensure: scoped default-mode activating load.
    loadOpenClawPlugins({
      workspaceDir: gate.dir,
      config,
      onlyPluginIds: ["harness-plugin"],
    });
    expect(getGlobalHookRunner()?.hasHooks("before_tool_call")).toBe(true);

    // 3. Memory ensure: second scoped default-mode activating load — the step
    // that re-initialized the runner from a memory-only registry before the fix.
    const memoryRegistry = loadOpenClawPlugins({
      workspaceDir: gate.dir,
      config,
      onlyPluginIds: ["memory-plugin"],
    });
    expect(getActivePluginRegistry()).toBe(memoryRegistry);

    const runner = getGlobalHookRunner();
    expect(runner?.hasHooks("before_tool_call")).toBe(true);
    expect(runner?.hasHooks("after_tool_call")).toBe(true);

    // The blocking decision must actually dispatch, not just count hooks.
    const result = await runner?.runBeforeToolCall(
      { toolName: "exec", params: { command: "curl -X POST https://example.com" } },
      { toolName: "exec" },
    );
    expect(result?.block).toBe(true);
    expect(result?.blockReason).toBe("blocked by gate");
  });
});
