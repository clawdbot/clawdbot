import { wrapToolWithBeforeToolCallHook } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  createTerminalPresentationContractTool,
  textToolResult,
} from "openclaw/plugin-sdk/agent-runtime-test-contracts";
// Covers embedded runner extension factories and tool-result middleware bridge.
import {
  AuthStorage,
  createEventBus,
  createExtensionRuntime,
  ExtensionRunner,
  loadExtensionFromFactory,
  ModelRegistry,
  SessionManager,
} from "openclaw/plugin-sdk/agent-sessions";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import {
  consumeAdjustedParamsForToolCall,
  recordAdjustedParamsForToolCall,
} from "./agent-tools.before-tool-call.js";
import { buildEmbeddedExtensionFactories } from "./embedded-agent-runner/extensions.js";
import { consumeEmbeddedToolSendReceipt } from "./embedded-agent-runner/tool-send-receipts.js";
import { cleanupTempPluginTestEnvironment } from "./test-helpers/temp-plugin-extension-fixtures.js";
import { jsonResult } from "./tools/common.js";

const originalBundledPluginsDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
const tempDirs: string[] = [];

afterEach(() => {
  cleanupTempPluginTestEnvironment(tempDirs, originalBundledPluginsDir);
});

describe("buildEmbeddedExtensionFactories", () => {
  it("bridges middleware mutations with unique fallback tool call ids", async () => {
    // Middleware invoked from app-server style tool_result events may not have a
    // call id; synthesize stable unique ids for downstream audit/mutation hooks.
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
      runtimes: ["openclaw"],
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
    expect(seenToolCallIds[0]).toMatch(/^openclaw-/);
    expect(seenToolCallIds[1]).toMatch(/^openclaw-/);
    expect(seenToolCallIds[0]).not.toBe(seenToolCallIds[1]);
  });

  it("finalizes terminal presentation from the post-middleware result", async () => {
    const registry = createEmptyPluginRegistry();
    const seenMiddlewareArgs: unknown[] = [];
    registry.agentToolResultMiddlewares.push({
      pluginId: "redactor",
      pluginName: "redactor",
      rawHandler: () => undefined,
      handler: (event) => {
        seenMiddlewareArgs.push(structuredClone(event.args));
        (event.args as { url?: string }).url = "https://mutated.example";
        return {
          result: textToolResult("redacted output", {
            origin: "redacted.example",
            status: 200,
          }),
        };
      },
      runtimes: ["openclaw"],
      source: "test",
    });
    setActivePluginRegistry(registry);
    const onToolOutcome = vi.fn();
    const tool = wrapToolWithBeforeToolCallHook(
      createTerminalPresentationContractTool({
        name: "web_fetch",
        result: textToolResult("raw output", {
          origin: "private.example",
          status: 200,
        }),
        format: (params, result) => {
          const input = params as { url?: string };
          const details = result.details as { origin?: string; status?: number };
          return `URL: ${String(input.url)}\nOrigin: ${String(details.origin)}\nStatus: ${String(details.status)}`;
        },
      }),
      {
        runId: "run-terminal-middleware",
        sessionId: "session-terminal-middleware",
        onToolOutcome,
      },
    );
    const rawResult = await tool.execute(
      "call-terminal-middleware",
      { url: "https://private.example" },
      undefined,
      undefined,
    );
    recordAdjustedParamsForToolCall(
      "call-terminal-middleware",
      { url: "https://approved.example" },
      "run-terminal-middleware",
    );
    const factories = buildEmbeddedExtensionFactories({
      cfg: undefined,
      sessionManager: SessionManager.inMemory(),
      provider: "openai",
      modelId: "gpt-5.4",
      model: undefined,
      runId: "run-terminal-middleware",
    });
    const handlers = new Map<string, Function>();
    await factories[0]?.({
      on(event: string, handler: Function) {
        handlers.set(event, handler);
      },
    } as never);

    await handlers.get("tool_result")?.(
      {
        toolName: "web_fetch",
        toolCallId: "call-terminal-middleware",
        input: { url: "https://private.example" },
        content: rawResult.content,
        details: rawResult.details,
      },
      { cwd: "/tmp" },
    );

    expect(onToolOutcome).toHaveBeenLastCalledWith(
      expect.objectContaining({
        presentationOnly: true,
        terminalPresentation: "URL: https://private.example\nOrigin: redacted.example\nStatus: 200",
      }),
    );
    expect(seenMiddlewareArgs).toEqual([{ url: "https://approved.example" }]);
    expect(
      consumeAdjustedParamsForToolCall("call-terminal-middleware", "run-terminal-middleware"),
    ).toEqual({ url: "https://approved.example" });
  });

  it("clears terminal presentation when middleware blocks the result", async () => {
    const registry = createEmptyPluginRegistry();
    registry.agentToolResultMiddlewares.push({
      pluginId: "blocker",
      pluginName: "Blocker",
      rawHandler: () => undefined,
      handler: () => ({
        result: textToolResult("blocked by middleware", {
          status: "blocked",
          reason: "policy denied",
        }),
      }),
      runtimes: ["openclaw"],
      source: "test",
    });
    setActivePluginRegistry(registry);
    const onToolOutcome = vi.fn();
    const tool = wrapToolWithBeforeToolCallHook(
      createTerminalPresentationContractTool({
        name: "web_fetch",
        result: textToolResult("raw output", {
          origin: "private.example",
          status: 200,
        }),
        format: () => "Origin: private.example",
      }),
      {
        runId: "run-terminal-blocked",
        sessionId: "session-terminal-blocked",
        onToolOutcome,
      },
    );
    const rawResult = await tool.execute(
      "call-terminal-blocked",
      { url: "https://private.example" },
      undefined,
      undefined,
    );
    const factories = buildEmbeddedExtensionFactories({
      cfg: undefined,
      sessionManager: SessionManager.inMemory(),
      provider: "openai",
      modelId: "gpt-5.4",
      model: undefined,
      runId: "run-terminal-blocked",
    });
    const handlers = new Map<string, Function>();
    await factories[0]?.({
      on(event: string, handler: Function) {
        handlers.set(event, handler);
      },
    } as never);

    const result = await handlers.get("tool_result")?.(
      {
        toolName: "web_fetch",
        toolCallId: "call-terminal-blocked",
        input: { url: "https://private.example" },
        content: rawResult.content,
        details: rawResult.details,
      },
      { cwd: "/tmp" },
    );

    expect(result).toMatchObject({ isError: true });
    expect(onToolOutcome).toHaveBeenLastCalledWith(
      expect.objectContaining({
        presentationOnly: true,
        terminalPresentation: undefined,
      }),
    );
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
    // Once a tool result is classified as model-visible failure, middleware
    // redaction must not accidentally clear the error signal.
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
      runtimes: ["openclaw"],
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

  it("stores provider send receipts without overriding middleware details", async () => {
    const registry = createEmptyPluginRegistry();
    registry.agentToolResultMiddlewares.push({
      pluginId: "redactor",
      pluginName: "redactor",
      rawHandler: () => undefined,
      handler: (event) => ({
        result: {
          content: event.result.content,
          details: { redacted: true },
        },
      }),
      runtimes: ["openclaw"],
      source: "test",
    });
    setActivePluginRegistry(registry);

    const sessionManager = SessionManager.inMemory();
    const factories = buildEmbeddedExtensionFactories({
      cfg: undefined,
      sessionManager,
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

    const result = await handlers.get("tool_result")?.(
      {
        toolName: "message",
        toolCallId: "call-message",
        content: [{ type: "text", text: "Sent." }],
        details: {
          toolSend: {
            to: "channel:resolved-id",
            threadId: "root-1",
          },
        },
      },
      { cwd: "/tmp" },
    );

    expect(result).toEqual({
      content: [{ type: "text", text: "Sent." }],
      details: { redacted: true },
    });
    expect(consumeEmbeddedToolSendReceipt(sessionManager, "call-message")).toEqual({
      details: {
        toolSend: {
          to: "channel:resolved-id",
          threadId: "root-1",
        },
      },
    });
    expect(consumeEmbeddedToolSendReceipt(sessionManager, "call-message")).toBeUndefined();
  });

  it("keeps a confirmed send successful when result middleware fails", async () => {
    const registry = createEmptyPluginRegistry();
    registry.agentToolResultMiddlewares.push({
      pluginId: "broken-redactor",
      pluginName: "broken redactor",
      rawHandler: () => undefined,
      handler: () => {
        throw new Error("redaction failed");
      },
      runtimes: ["openclaw"],
      source: "test",
    });
    setActivePluginRegistry(registry);

    const sessionManager = SessionManager.inMemory();
    const factories = buildEmbeddedExtensionFactories({
      cfg: undefined,
      sessionManager,
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

    const result = await handlers.get("tool_result")?.(
      {
        toolName: "message",
        toolCallId: "call-message",
        input: { action: "send", target: "C123" },
        content: [{ type: "text", text: "raw result must stay private" }],
        details: {
          ok: true,
          result: { messageId: "1700000000.000100", channelId: "C123" },
          toolSend: { to: "channel:C123" },
        },
      },
      { cwd: "/tmp" },
    );

    expect(result).toEqual({
      content: [{ type: "text", text: "Message delivered, but result post-processing failed." }],
      details: {
        ok: true,
        deliveryStatus: "sent",
        middlewareWarning: "post-processing failed",
      },
    });
    expect(consumeEmbeddedToolSendReceipt(sessionManager, "call-message")).toEqual({
      details: { toolSend: { to: "channel:C123" } },
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

  it("keeps an accepted sessions_spawn launch successful even when the event is flagged as an error", async () => {
    setActivePluginRegistry(createEmptyPluginRegistry());

    const factories = buildEmbeddedExtensionFactories({
      cfg: undefined,
      sessionManager: SessionManager.inMemory(),
      provider: "openai",
      modelId: "gpt-5.4",
      model: undefined,
    });

    const factory = factories[0];
    expect(factory).toBeDefined();
    if (!factory) {
      throw new Error("Expected embedded tool-result extension factory");
    }
    const runtime = createExtensionRuntime();
    const extension = await loadExtensionFromFactory(
      factory,
      "/tmp",
      createEventBus(),
      runtime,
      "<embedded-test>",
    );
    const runner = new ExtensionRunner(
      [extension],
      runtime,
      "/tmp",
      SessionManager.inMemory(),
      ModelRegistry.inMemory(AuthStorage.inMemory()),
    );
    const acceptedResult = jsonResult({
      status: "accepted",
      childSessionKey: "agent:watcher:subagent:abc",
      runId: "run-123",
      mode: "run",
    });

    const result = await runner.emitToolResult({
      type: "tool_result",
      toolName: "sessions_spawn",
      toolCallId: "call-spawn",
      input: {},
      content: acceptedResult.content,
      details: acceptedResult.details,
      isError: true,
    });

    expect(result).toEqual({ ...acceptedResult, isError: false });
  });

  it("still marks a forbidden sessions_spawn as a model-visible failure", async () => {
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
    const content = [{ type: "text", text: "spawn denied" }];
    const details = { status: "forbidden", reason: "subagents disabled" };

    const result = await handler?.(
      {
        toolName: "sessions_spawn",
        toolCallId: "call-spawn-forbidden",
        content,
        details,
        isError: true,
      },
      { cwd: "/tmp" },
    );

    expect(result).toEqual({ content, details, isError: true });
  });

  it("still flags an accepted-status sessions_spawn that is missing spawn identity", async () => {
    // Only the full accepted contract (runId + childSessionKey) is a launch; an
    // accepted status alone must not clear an error flag.
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
    const content = [{ type: "text", text: "partial" }];
    const details = { status: "accepted" };

    const result = await handler?.(
      {
        toolName: "sessions_spawn",
        toolCallId: "call-spawn-partial",
        content,
        details,
        isError: true,
      },
      { cwd: "/tmp" },
    );

    expect(result).toEqual({ content, details, isError: true });
  });

  it("does not clear the error flag for a non-spawn tool with accepted-shaped details", async () => {
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
    const content = [{ type: "text", text: "boom" }];
    const details = jsonResult({
      status: "accepted",
      childSessionKey: "agent:watcher:subagent:abc",
      runId: "run-123",
    }).details;

    const result = await handler?.(
      {
        toolName: "exec",
        toolCallId: "call-exec-accepted-shape",
        content,
        details,
        isError: true,
      },
      { cwd: "/tmp" },
    );

    expect(result).toEqual({ content, details, isError: true });
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
