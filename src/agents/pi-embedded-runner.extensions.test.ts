import { SessionManager } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { buildEmbeddedExtensionFactories } from "./pi-embedded-runner/extensions.js";
import { cleanupTempPluginTestEnvironment } from "./test-helpers/temp-plugin-extension-fixtures.js";

const originalBundledPluginsDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
const tempDirs: string[] = [];

afterEach(() => {
  cleanupTempPluginTestEnvironment(tempDirs, originalBundledPluginsDir);
});

describe("buildEmbeddedExtensionFactories", () => {
  it("bridges middleware mutations with unique fallback tool call ids", async () => {
    const seenToolCallIds: string[] = [];
    const registry = createEmptyPluginRegistry();
    registry.agentToolResultMiddlewares.push({
      pluginId: "tokenjuice",
      pluginName: "tokenjuice",
      rawHandler: () => undefined,
      handler: (event) => {
        seenToolCallIds.push(event.toolCallId);
        event.result.content = [{ type: "text", text: `compacted ${seenToolCallIds.length}` }];
        return undefined;
      },
      runtimes: ["pi"],
      source: "test",
    });
    setActivePluginRegistry(registry);

    const factories = buildEmbeddedExtensionFactories({
      cfg: undefined,
      sessionManager: SessionManager.inMemory(),
      provider: "openai",
      modelId: "gpt-5.4",
      model: undefined,
    });
    expect(factories).toHaveLength(1);

    const handlers = new Map<string, Function>();
    await factories[0]?.({
      on(event: string, handler: Function) {
        handlers.set(event, handler);
      },
    } as never);
    const handler = handlers.get("tool_result");

    const first = await handler?.(
      { toolName: "exec", content: [{ type: "text", text: "raw 1" }], details: {} },
      { cwd: "/tmp" },
    );
    const second = await handler?.(
      { toolName: "exec", content: [{ type: "text", text: "raw 2" }], details: {} },
      { cwd: "/tmp" },
    );

    expect(first).toEqual({
      content: [{ type: "text", text: "compacted 1" }],
      details: {},
    });
    expect(second).toEqual({
      content: [{ type: "text", text: "compacted 2" }],
      details: {},
    });
    expect(seenToolCallIds).toHaveLength(2);
    expect(seenToolCallIds[0]).toMatch(/^pi-/);
    expect(seenToolCallIds[1]).toMatch(/^pi-/);
    expect(seenToolCallIds[0]).not.toBe(seenToolCallIds[1]);
  });
});
