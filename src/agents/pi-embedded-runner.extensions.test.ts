import { SessionManager } from "@earendil-works/pi-coding-agent";
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

  it("marks status-error tool results as model-visible failures", async () => {
    setActivePluginRegistry(createEmptyPluginRegistry());

    const factories = buildEmbeddedExtensionFactories({
      cfg: undefined,
      sessionManager: SessionManager.inMemory(),
      provider: "openai",
      modelId: "gpt-5.4",
      model: undefined,
    });

    const handlers = new Map<string, Function>();
    await factories[0]?.({
      on(event: string, handler: Function) {
        handlers.set(event, handler);
      },
    } as never);
    const handler = handlers.get("tool_result");
    const content = [{ type: "text", text: "oldText must be unique" }];
    const details = {
      status: "error",
      tool: "edit",
      error: "oldText must be unique",
    };

    const result = await handler?.(
      {
        toolName: "edit",
        toolCallId: "call-edit",
        content,
        details,
        isError: false,
      },
      { cwd: "/tmp" },
    );

    expect(result).toEqual({
      content,
      details,
      isError: true,
    });
  });

  it("preserves model-visible failures when middleware rewrites details", async () => {
    const registry = createEmptyPluginRegistry();
    registry.agentToolResultMiddlewares.push({
      pluginId: "redactor",
      pluginName: "redactor",
      rawHandler: () => undefined,
      handler: (event) => {
        event.result.content = [{ type: "text", text: "redacted error" }];
        event.result.details = { redacted: true };
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

    const handlers = new Map<string, Function>();
    await factories[0]?.({
      on(event: string, handler: Function) {
        handlers.set(event, handler);
      },
    } as never);
    const handler = handlers.get("tool_result");

    const result = await handler?.(
      {
        toolName: "edit",
        toolCallId: "call-edit",
        content: [{ type: "text", text: "oldText must be unique" }],
        details: { status: "error", tool: "edit", error: "oldText must be unique" },
        isError: false,
      },
      { cwd: "/tmp" },
    );

    expect(result).toEqual({
      content: [{ type: "text", text: "redacted error" }],
      details: { redacted: true },
      isError: true,
    });
  });

  it("marks status-timeout tool results as model-visible failures", async () => {
    setActivePluginRegistry(createEmptyPluginRegistry());

    const factories = buildEmbeddedExtensionFactories({
      cfg: undefined,
      sessionManager: SessionManager.inMemory(),
      provider: "openai",
      modelId: "gpt-5.4",
      model: undefined,
    });

    const handlers = new Map<string, Function>();
    await factories[0]?.({
      on(event: string, handler: Function) {
        handlers.set(event, handler);
      },
    } as never);
    const handler = handlers.get("tool_result");

    const result = await handler?.(
      {
        toolName: "exec",
        toolCallId: "call-exec",
        content: [{ type: "text", text: "Timed out" }],
        details: { status: "timeout", tool: "exec", error: "Timed out" },
        isError: false,
      },
      { cwd: "/tmp" },
    );

    expect(result).toEqual({
      content: [{ type: "text", text: "Timed out" }],
      details: { status: "timeout", tool: "exec", error: "Timed out" },
      isError: true,
    });
  });

  it("does not mark results as errors when status is absent or non-error", async () => {
    setActivePluginRegistry(createEmptyPluginRegistry());

    const factories = buildEmbeddedExtensionFactories({
      cfg: undefined,
      sessionManager: SessionManager.inMemory(),
      provider: "openai",
      modelId: "gpt-5.4",
      model: undefined,
    });

    const handlers = new Map<string, Function>();
    await factories[0]?.({
      on(event: string, handler: Function) {
        handlers.set(event, handler);
      },
    } as never);
    const handler = handlers.get("tool_result");

    // Empty details — no status field
    const noStatusResult = await handler?.(
      {
        toolName: "read",
        toolCallId: "call-read",
        content: [{ type: "text", text: "file contents" }],
        details: {},
        isError: false,
      },
      { cwd: "/tmp" },
    );
    expect(noStatusResult).toEqual({
      content: [{ type: "text", text: "file contents" }],
      details: {},
    });

    // Explicit ok status
    const okResult = await handler?.(
      {
        toolName: "read",
        toolCallId: "call-read-2",
        content: [{ type: "text", text: "ok" }],
        details: { status: "ok" },
        isError: false,
      },
      { cwd: "/tmp" },
    );
    expect(okResult).toEqual({
      content: [{ type: "text", text: "ok" }],
      details: { status: "ok" },
    });
  });
});
