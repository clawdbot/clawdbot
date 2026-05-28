import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { updateSessionStore, type SessionEntry } from "../config/sessions.js";
import { resetDiagnosticSessionStateForTest } from "../logging/diagnostic-session-state.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { addTestHook, createMockPluginRegistry } from "../plugins/hooks.test-helpers.js";
import { patchPluginSessionExtension } from "../plugins/host-hook-state.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import type { PluginHookRegistration } from "../plugins/types.js";
import { toClientToolDefinitions, toToolDefinitions } from "./agent-tool-definition-adapter.js";
import { wrapToolWithAbortSignal } from "./agent-tools.abort.js";
import {
  testing as beforeToolCallTesting,
  consumeAdjustedParamsForToolCall,
  isToolWrappedWithBeforeToolCallHook,
  wrapToolWithBeforeToolCallHook,
} from "./agent-tools.before-tool-call.js";
import { markCodeModeControlTool } from "./code-mode-control-tools.js";
import { CODE_MODE_EXEC_TOOL_NAME, createCodeModeTools } from "./code-mode.js";
import { splitSdkTools } from "./embedded-agent-runner.js";

type BeforeToolCallHandlerMock = ReturnType<typeof vi.fn>;

type BeforeToolCallHookInstall = {
  pluginId: string;
  priority?: number;
  handler: BeforeToolCallHandlerMock;
};

function collectMatching<T, U>(
  items: readonly T[],
  predicate: (item: T) => boolean,
  map: (item: T) => U,
): U[] {
  const matches: U[] = [];
  for (const item of items) {
    if (predicate(item)) {
      matches.push(map(item));
    }
  }
  return matches;
}

function installBeforeToolCallHook(params?: {
  enabled?: boolean;
  runBeforeToolCallImpl?: (...args: unknown[]) => unknown;
}): BeforeToolCallHandlerMock {
  resetGlobalHookRunner();
  const handler = params?.runBeforeToolCallImpl
    ? vi.fn(params.runBeforeToolCallImpl)
    : vi.fn(async () => undefined);
  if (params?.enabled === false) {
    return handler;
  }
  initializeGlobalHookRunner(createMockPluginRegistry([{ hookName: "before_tool_call", handler }]));
  return handler;
}

function installBeforeToolCallHooks(hooks: BeforeToolCallHookInstall[]): void {
  resetGlobalHookRunner();
  const registry = createEmptyPluginRegistry();
  for (const hook of hooks) {
    addTestHook({
      registry,
      pluginId: hook.pluginId,
      hookName: "before_tool_call",
      handler: hook.handler as PluginHookRegistration["handler"],
      priority: hook.priority,
    });
  }
  initializeGlobalHookRunner(registry);
}

describe("before_tool_call hook integration", () => {
  let beforeToolCallHook: BeforeToolCallHandlerMock;

  beforeEach(() => {
    resetGlobalHookRunner();
    resetDiagnosticSessionStateForTest();
    beforeToolCallTesting.adjustedParamsByToolCallId.clear();
    beforeToolCallHook = installBeforeToolCallHook();
  });

  it("executes tool normally when no hook is registered", async () => {
    beforeToolCallHook = installBeforeToolCallHook({ enabled: false });
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const tool = wrapToolWithBeforeToolCallHook({ name: "Read", execute } as any, {
      agentId: "main",
      sessionKey: "main",
    });
    const extensionContext = {} as Parameters<typeof tool.execute>[3];

    await tool.execute("call-1", { path: "/tmp/file" }, undefined, extensionContext);

    expect(beforeToolCallHook).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledWith(
      "call-1",
      { path: "/tmp/file" },
      undefined,
      extensionContext,
    );
  });

  it("allows hook to modify parameters", async () => {
    beforeToolCallHook = installBeforeToolCallHook({
      runBeforeToolCallImpl: async () => ({ params: { mode: "safe" } }),
    });
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const tool = wrapToolWithBeforeToolCallHook({ name: "exec", execute } as any);
    const extensionContext = {} as Parameters<typeof tool.execute>[3];

    await tool.execute("call-2", { cmd: "ls" }, undefined, extensionContext);

    expect(execute).toHaveBeenCalledWith(
      "call-2",
      { cmd: "ls", mode: "safe" },
      undefined,
      extensionContext,
    );
  });

  it("returns first-class blocked tool result when hook returns block=true", async () => {
    beforeToolCallHook = installBeforeToolCallHook({
      runBeforeToolCallImpl: async () => ({
        block: true,
        blockReason: "blocked",
      }),
    });
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const tool = wrapToolWithBeforeToolCallHook({ name: "exec", execute } as any);
    const extensionContext = {} as Parameters<typeof tool.execute>[3];

    await expect(
      tool.execute("call-3", { cmd: "rm -rf /" }, undefined, extensionContext),
    ).resolves.toEqual({
      content: [{ type: "text", text: "blocked" }],
      details: {
        status: "blocked",
        deniedReason: "plugin-before-tool-call",
        reason: "blocked",
      },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not execute lower-priority hooks after block=true", async () => {
    const high = vi.fn().mockResolvedValue({ block: true, blockReason: "blocked-high" });
    const low = vi.fn().mockResolvedValue({ params: { shouldNotApply: true } });
    installBeforeToolCallHooks([
      { pluginId: "high", priority: 100, handler: high },
      { pluginId: "low", priority: 0, handler: low },
    ]);

    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const tool = wrapToolWithBeforeToolCallHook({ name: "exec", execute } as any);
    const extensionContext = {} as Parameters<typeof tool.execute>[3];

    await expect(
      tool.execute("call-stop", { cmd: "rm -rf /" }, undefined, extensionContext),
    ).resolves.toEqual({
      content: [{ type: "text", text: "blocked-high" }],
      details: {
        status: "blocked",
        deniedReason: "plugin-before-tool-call",
        reason: "blocked-high",
      },
    });

    expect(high).toHaveBeenCalledTimes(1);
    expect(low).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("blocks tool execution when hook throws", async () => {
    beforeToolCallHook = installBeforeToolCallHook({
      runBeforeToolCallImpl: async () => {
        throw new Error("boom");
      },
    });
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const tool = wrapToolWithBeforeToolCallHook({ name: "read", execute } as any);
    const extensionContext = {} as Parameters<typeof tool.execute>[3];

    await expect(
      tool.execute("call-4", { path: "/tmp/file" }, undefined, extensionContext),
    ).rejects.toThrow("Tool call blocked because before_tool_call hook failed");
    expect(execute).not.toHaveBeenCalled();
  });

  it("normalizes non-object params for hook contract", async () => {
    beforeToolCallHook = installBeforeToolCallHook({
      runBeforeToolCallImpl: async () => undefined,
    });
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const tool = wrapToolWithBeforeToolCallHook({ name: "ReAd", execute } as any, {
      agentId: "main",
      sessionKey: "main",
      sessionId: "ephemeral-main",
      runId: "run-main",
    });
    const extensionContext = {} as Parameters<typeof tool.execute>[3];

    await tool.execute("call-5", "not-an-object", undefined, extensionContext);

    expect(execute).toHaveBeenCalledWith("call-5", "not-an-object", undefined, extensionContext);
    expect(beforeToolCallHook).toHaveBeenCalledWith(
      {
        toolName: "read",
        params: {},
        runId: "run-main",
        toolCallId: "call-5",
      },
      {
        toolName: "read",
        agentId: "main",
        sessionKey: "main",
        sessionId: "ephemeral-main",
        runId: "run-main",
        toolCallId: "call-5",
      },
    );
  });

  it("keeps adjusted params isolated per run when toolCallId collides", async () => {
    beforeToolCallHook = installBeforeToolCallHook({
      runBeforeToolCallImpl: vi
        .fn()
        .mockResolvedValueOnce({ params: { marker: "A" } })
        .mockResolvedValueOnce({ params: { marker: "B" } }),
    });
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const toolA = wrapToolWithBeforeToolCallHook({ name: "Read", execute } as any, {
      runId: "run-a",
    });
    const toolB = wrapToolWithBeforeToolCallHook({ name: "Read", execute } as any, {
      runId: "run-b",
    });
    const extensionContextA = {} as Parameters<typeof toolA.execute>[3];
    const extensionContextB = {} as Parameters<typeof toolB.execute>[3];
    const sharedToolCallId = "shared-call";

    await toolA.execute(sharedToolCallId, { path: "/tmp/a.txt" }, undefined, extensionContextA);
    await toolB.execute(sharedToolCallId, { path: "/tmp/b.txt" }, undefined, extensionContextB);

    expect(consumeAdjustedParamsForToolCall(sharedToolCallId, "run-a")).toEqual({
      path: "/tmp/a.txt",
      marker: "A",
    });
    expect(consumeAdjustedParamsForToolCall(sharedToolCallId, "run-b")).toEqual({
      path: "/tmp/b.txt",
      marker: "B",
    });
    expect(consumeAdjustedParamsForToolCall(sharedToolCallId, "run-a")).toBeUndefined();
  });
});

describe("before_tool_call hook deduplication (#15502)", () => {
  let beforeToolCallHook: BeforeToolCallHandlerMock;

  beforeEach(() => {
    resetGlobalHookRunner();
    resetDiagnosticSessionStateForTest();
    beforeToolCallHook = installBeforeToolCallHook({
      runBeforeToolCallImpl: async () => undefined,
    });
  });

  it("fires hook exactly once when tool goes through wrap + toToolDefinitions", async () => {
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const baseTool = { name: "web_fetch", execute, description: "fetch", parameters: {} } as any;

    const wrapped = wrapToolWithBeforeToolCallHook(baseTool, {
      agentId: "main",
      sessionKey: "main",
    });
    const [def] = toToolDefinitions([wrapped]);
    const extensionContext = {} as Parameters<typeof def.execute>[4];
    await def.execute(
      "call-dedup",
      { url: "https://example.com" },
      undefined,
      undefined,
      extensionContext,
    );

    expect(beforeToolCallHook).toHaveBeenCalledTimes(1);
  });

  it("passes agent context to outer code-mode exec hooks through OpenClaw custom tools", async () => {
    beforeToolCallHook = installBeforeToolCallHook({
      runBeforeToolCallImpl: async () => ({
        block: true,
        blockReason: "blocked before code-mode execution",
      }),
    });
    const abortController = new AbortController();
    const codeModeTools = createCodeModeTools({
      agentId: "main",
      sessionKey: "agent:main:main",
      sessionId: "session-main",
      runId: "run-main",
      abortSignal: abortController.signal,
      executeTool: async () => {
        throw new Error("catalog tool execution should not be reached");
      },
    });
    const execTool = codeModeTools.find((tool) => tool.name === CODE_MODE_EXEC_TOOL_NAME);
    if (!execTool) {
      throw new Error("missing code-mode exec tool");
    }
    const { customTools } = splitSdkTools({
      tools: [execTool],
      sandboxEnabled: false,
      toolHookContext: {
        agentId: "main",
        sessionKey: "agent:main:main",
        sessionId: "session-main",
        runId: "run-main",
      },
    });
    const [def] = customTools;
    if (!def) {
      throw new Error("missing custom tool definition");
    }
    const extensionContext = {} as Parameters<typeof def.execute>[4];

    const result = await def.execute(
      "call-code-mode-exec",
      { code: "return 1;" },
      undefined,
      undefined,
      extensionContext,
    );

    expect(result.details).toMatchObject({
      status: "blocked",
      reason: "blocked before code-mode execution",
    });
    expect(beforeToolCallHook).toHaveBeenCalledWith(
      {
        toolName: "exec",
        params: { code: "return 1;", command: "return 1;" },
        toolKind: "code_mode_exec",
        toolInputKind: "javascript",
        runId: "run-main",
        toolCallId: "call-code-mode-exec",
      },
      {
        toolName: "exec",
        toolKind: "code_mode_exec",
        toolInputKind: "javascript",
        agentId: "main",
        sessionKey: "agent:main:main",
        sessionId: "session-main",
        runId: "run-main",
        toolCallId: "call-code-mode-exec",
      },
    );

    beforeToolCallHook.mockClear();
    const commandOnlyResult = await def.execute(
      "call-code-mode-exec-command",
      { command: "return 2;" },
      undefined,
      undefined,
      extensionContext,
    );

    expect(commandOnlyResult.details).toMatchObject({
      status: "blocked",
      reason: "blocked before code-mode execution",
    });
    expect(beforeToolCallHook).toHaveBeenCalledWith(
      {
        toolName: "exec",
        params: { code: "return 2;", command: "return 2;" },
        toolKind: "code_mode_exec",
        toolInputKind: "javascript",
        runId: "run-main",
        toolCallId: "call-code-mode-exec-command",
      },
      {
        toolName: "exec",
        toolKind: "code_mode_exec",
        toolInputKind: "javascript",
        agentId: "main",
        sessionKey: "agent:main:main",
        sessionId: "session-main",
        runId: "run-main",
        toolCallId: "call-code-mode-exec-command",
      },
    );

    beforeToolCallHook.mockClear();
    const typescriptResult = await def.execute(
      "call-code-mode-exec-typescript",
      {
        code: "const value: number = 5;",
        language: "typescript",
      },
      undefined,
      undefined,
      extensionContext,
    );

    expect(typescriptResult.details).toMatchObject({
      status: "blocked",
      reason: "blocked before code-mode execution",
    });
    expect(beforeToolCallHook).toHaveBeenCalledWith(
      {
        toolName: "exec",
        params: {
          code: "const value: number = 5;",
          command: "const value: number = 5;",
          language: "typescript",
        },
        toolKind: "code_mode_exec",
        toolInputKind: "typescript",
        runId: "run-main",
        toolCallId: "call-code-mode-exec-typescript",
      },
      {
        toolName: "exec",
        toolKind: "code_mode_exec",
        toolInputKind: "typescript",
        agentId: "main",
        sessionKey: "agent:main:main",
        sessionId: "session-main",
        runId: "run-main",
        toolCallId: "call-code-mode-exec-typescript",
      },
    );

    beforeToolCallHook.mockClear();
    const malformedAliasResult = await def.execute(
      "call-code-mode-exec-null-command",
      { code: "return 4;", command: null },
      undefined,
      undefined,
      extensionContext,
    );

    expect(malformedAliasResult.details).toMatchObject({
      status: "blocked",
      reason: "blocked before code-mode execution",
    });
    expect(beforeToolCallHook).toHaveBeenCalledWith(
      {
        toolName: "exec",
        params: { code: "return 4;", command: "return 4;" },
        toolKind: "code_mode_exec",
        toolInputKind: "javascript",
        runId: "run-main",
        toolCallId: "call-code-mode-exec-null-command",
      },
      {
        toolName: "exec",
        toolKind: "code_mode_exec",
        toolInputKind: "javascript",
        agentId: "main",
        sessionKey: "agent:main:main",
        sessionId: "session-main",
        runId: "run-main",
        toolCallId: "call-code-mode-exec-null-command",
      },
    );
  });

  it("marks code-mode exec without marking plain exec hooks", async () => {
    const observed: Array<{
      event: Record<string, unknown>;
      ctx: Record<string, unknown>;
    }> = [];
    beforeToolCallHook = installBeforeToolCallHook({
      runBeforeToolCallImpl: async (event, ctx) => {
        observed.push({
          event: event as Record<string, unknown>,
          ctx: ctx as Record<string, unknown>,
        });
        if ((event as Record<string, unknown>).toolKind === "code_mode_exec") {
          return { block: true, blockReason: "blocked before code-mode execution" };
        }
        return { params: (event as { params: Record<string, unknown> }).params };
      },
    });
    const plainExecute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const [plainExecDef] = toToolDefinitions(
      [{ name: "exec", execute: plainExecute, description: "Plain exec", parameters: {} } as any],
      {
        agentId: "main",
        sessionKey: "agent:main:main",
        sessionId: "session-main",
        runId: "run-main",
      },
    );
    const codeModeTools = createCodeModeTools({
      agentId: "main",
      sessionKey: "agent:main:main",
      sessionId: "session-main",
      runId: "run-main",
      abortSignal: new AbortController().signal,
      executeTool: async () => {
        throw new Error("catalog tool execution should not be reached");
      },
    });
    const codeModeExec = codeModeTools.find((tool) => tool.name === CODE_MODE_EXEC_TOOL_NAME);
    if (!plainExecDef || !codeModeExec) {
      throw new Error("missing exec definitions");
    }
    const [codeModeExecDef] = toToolDefinitions([codeModeExec], {
      agentId: "main",
      sessionKey: "agent:main:main",
      sessionId: "session-main",
      runId: "run-main",
    });
    if (!codeModeExecDef) {
      throw new Error("missing code-mode exec definition");
    }
    const extensionContext = {} as Parameters<typeof plainExecDef.execute>[4];

    await plainExecDef.execute(
      "call-plain-exec",
      { command: "echo hi" },
      undefined,
      undefined,
      extensionContext,
    );
    const codeModeResult = await codeModeExecDef.execute(
      "call-code-mode-exec",
      { code: "return 1;" },
      undefined,
      undefined,
      extensionContext,
    );

    expect(plainExecute).toHaveBeenCalledWith(
      "call-plain-exec",
      { command: "echo hi" },
      undefined,
      undefined,
    );
    expect(codeModeResult.details).toMatchObject({
      status: "blocked",
      reason: "blocked before code-mode execution",
    });
    expect(observed[0]?.event).toMatchObject({
      toolName: "exec",
      params: { command: "echo hi" },
    });
    expect(observed[0]?.event).not.toHaveProperty("toolKind");
    expect(observed[1]?.event).toMatchObject({
      toolName: "exec",
      params: { code: "return 1;", command: "return 1;" },
      toolKind: "code_mode_exec",
      toolInputKind: "javascript",
    });
    expect(observed[1]?.ctx).toMatchObject({
      toolName: "exec",
      toolKind: "code_mode_exec",
      toolInputKind: "javascript",
    });
  });

  it("normalizes outer code-mode exec hook params when a wrapper owns the hook", async () => {
    beforeToolCallHook = installBeforeToolCallHook({
      runBeforeToolCallImpl: async () => ({
        block: true,
        blockReason: "blocked before code-mode execution",
      }),
    });
    const codeModeTools = createCodeModeTools({
      agentId: "main",
      sessionKey: "agent:main:main",
      sessionId: "session-main",
      runId: "run-main",
      abortSignal: new AbortController().signal,
      executeTool: async () => {
        throw new Error("catalog tool execution should not be reached");
      },
    });
    const execTool = codeModeTools.find((tool) => tool.name === CODE_MODE_EXEC_TOOL_NAME);
    if (!execTool) {
      throw new Error("missing code-mode exec tool");
    }
    const wrapped = wrapToolWithAbortSignal(
      wrapToolWithBeforeToolCallHook(execTool, {
        agentId: "main",
        sessionKey: "agent:main:main",
        sessionId: "session-main",
        runId: "run-main",
      }),
      new AbortController().signal,
    );
    const [def] = toToolDefinitions([wrapped]);
    if (!def) {
      throw new Error("missing custom tool definition");
    }
    const extensionContext = {} as Parameters<typeof def.execute>[4];

    const result = await def.execute(
      "call-wrapped-code-mode-exec",
      { command: "return 3;" },
      undefined,
      undefined,
      extensionContext,
    );

    expect(result.details).toMatchObject({
      status: "blocked",
      reason: "blocked before code-mode execution",
    });
    expect(beforeToolCallHook).toHaveBeenCalledTimes(1);
    expect(beforeToolCallHook).toHaveBeenCalledWith(
      {
        toolName: "exec",
        params: { command: "return 3;", code: "return 3;" },
        toolKind: "code_mode_exec",
        toolInputKind: "javascript",
        runId: "run-main",
        toolCallId: "call-wrapped-code-mode-exec",
      },
      {
        toolName: "exec",
        toolKind: "code_mode_exec",
        toolInputKind: "javascript",
        agentId: "main",
        sessionKey: "agent:main:main",
        sessionId: "session-main",
        runId: "run-main",
        toolCallId: "call-wrapped-code-mode-exec",
      },
    );
  });

  it("mirrors single-alias hook rewrites for code-mode exec aliases", async () => {
    beforeToolCallHook = installBeforeToolCallHook({
      runBeforeToolCallImpl: async () => ({ params: { command: "return 2;" } }),
    });
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const tool = markCodeModeControlTool({
      name: CODE_MODE_EXEC_TOOL_NAME,
      execute,
      description: "exec",
      parameters: {},
    } as any);
    const [def] = toToolDefinitions([tool], {
      agentId: "main",
      sessionKey: "agent:main:main",
      sessionId: "session-main",
      runId: "run-main",
    });
    if (!def) {
      throw new Error("missing custom tool definition");
    }
    const extensionContext = {} as Parameters<typeof def.execute>[4];

    await def.execute(
      "call-code-mode-exec-rewrite",
      { code: "return 1;", command: "return 1;" },
      undefined,
      undefined,
      extensionContext,
    );

    expect(execute).toHaveBeenCalledWith(
      "call-code-mode-exec-rewrite",
      { code: "return 2;", command: "return 2;" },
      undefined,
      undefined,
    );
    expect(beforeToolCallHook).toHaveBeenCalledWith(
      {
        toolName: "exec",
        params: { code: "return 1;", command: "return 1;" },
        toolKind: "code_mode_exec",
        toolInputKind: "javascript",
        runId: "run-main",
        toolCallId: "call-code-mode-exec-rewrite",
      },
      {
        toolName: "exec",
        toolKind: "code_mode_exec",
        toolInputKind: "javascript",
        agentId: "main",
        sessionKey: "agent:main:main",
        sessionId: "session-main",
        runId: "run-main",
        toolCallId: "call-code-mode-exec-rewrite",
      },
    );
    expect(consumeAdjustedParamsForToolCall("call-code-mode-exec-rewrite", "run-main")).toEqual({
      code: "return 2;",
      command: "return 2;",
    });
  });

  it("renormalizes trusted policy rewrites before code-mode exec hooks observe params", async () => {
    resetGlobalHookRunner();
    const normalHook = vi.fn(async () => undefined);
    const trustedObserver = vi.fn(async () => undefined);
    const registry = createEmptyPluginRegistry();
    addTestHook({
      registry,
      pluginId: "normal-plugin",
      hookName: "before_tool_call",
      handler: normalHook as PluginHookRegistration["handler"],
    });
    registry.trustedToolPolicies = [
      {
        pluginId: "trusted-plugin",
        pluginName: "Trusted Plugin",
        source: "test",
        policy: {
          id: "code-mode-rewrite-policy",
          description: "rewrite code-mode exec params",
          evaluate(eventValue) {
            if (eventValue.toolCallId === "call-code-mode-trusted-command") {
              return { params: { command: "return 2;" } };
            }
            if (eventValue.toolCallId === "call-code-mode-trusted-language") {
              return {
                params: {
                  code: "const value: number = 3;",
                  command: "const value: number = 3;",
                  language: "typescript",
                },
              };
            }
            return undefined;
          },
        },
      },
      {
        pluginId: "trusted-observer",
        pluginName: "Trusted Observer",
        source: "test",
        policy: {
          id: "code-mode-observer-policy",
          description: "observe rewritten code-mode exec params",
          evaluate: trustedObserver,
        },
      },
    ];
    setActivePluginRegistry(registry);
    initializeGlobalHookRunner(registry);
    try {
      const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
      const tool = markCodeModeControlTool({
        name: CODE_MODE_EXEC_TOOL_NAME,
        execute,
        description: "exec",
        parameters: {},
      } as any);
      const [def] = toToolDefinitions([tool], {
        agentId: "main",
        sessionKey: "agent:main:main",
        sessionId: "session-main",
        runId: "run-main",
      });
      if (!def) {
        throw new Error("missing custom tool definition");
      }
      const extensionContext = {} as Parameters<typeof def.execute>[4];

      await def.execute(
        "call-code-mode-trusted-command",
        { code: "return 1;", command: "return 1;" },
        undefined,
        undefined,
        extensionContext,
      );
      await def.execute(
        "call-code-mode-trusted-language",
        { code: "return 3;", command: "return 3;", language: "javascript" },
        undefined,
        undefined,
        extensionContext,
      );

      expect(normalHook).toHaveBeenNthCalledWith(
        1,
        {
          toolName: "exec",
          params: { command: "return 2;", code: "return 2;" },
          toolKind: "code_mode_exec",
          toolInputKind: "javascript",
          runId: "run-main",
          toolCallId: "call-code-mode-trusted-command",
        },
        expect.objectContaining({
          toolName: "exec",
          toolKind: "code_mode_exec",
          toolInputKind: "javascript",
          agentId: "main",
          sessionKey: "agent:main:main",
          sessionId: "session-main",
          runId: "run-main",
          toolCallId: "call-code-mode-trusted-command",
        }),
      );
      expect(trustedObserver).toHaveBeenNthCalledWith(
        1,
        {
          toolName: "exec",
          params: { command: "return 2;", code: "return 2;" },
          toolKind: "code_mode_exec",
          toolInputKind: "javascript",
          runId: "run-main",
          toolCallId: "call-code-mode-trusted-command",
        },
        expect.objectContaining({
          toolName: "exec",
          toolKind: "code_mode_exec",
          toolInputKind: "javascript",
          agentId: "main",
          sessionKey: "agent:main:main",
          sessionId: "session-main",
          runId: "run-main",
          toolCallId: "call-code-mode-trusted-command",
        }),
      );
      expect(normalHook).toHaveBeenNthCalledWith(
        2,
        {
          toolName: "exec",
          params: {
            code: "const value: number = 3;",
            command: "const value: number = 3;",
            language: "typescript",
          },
          toolKind: "code_mode_exec",
          toolInputKind: "typescript",
          runId: "run-main",
          toolCallId: "call-code-mode-trusted-language",
        },
        expect.objectContaining({
          toolName: "exec",
          toolKind: "code_mode_exec",
          toolInputKind: "typescript",
          agentId: "main",
          sessionKey: "agent:main:main",
          sessionId: "session-main",
          runId: "run-main",
          toolCallId: "call-code-mode-trusted-language",
        }),
      );
      expect(trustedObserver).toHaveBeenNthCalledWith(
        2,
        {
          toolName: "exec",
          params: {
            code: "const value: number = 3;",
            command: "const value: number = 3;",
            language: "typescript",
          },
          toolKind: "code_mode_exec",
          toolInputKind: "typescript",
          runId: "run-main",
          toolCallId: "call-code-mode-trusted-language",
        },
        expect.objectContaining({
          toolName: "exec",
          toolKind: "code_mode_exec",
          toolInputKind: "typescript",
          agentId: "main",
          sessionKey: "agent:main:main",
          sessionId: "session-main",
          runId: "run-main",
          toolCallId: "call-code-mode-trusted-language",
        }),
      );
      expect(execute).toHaveBeenNthCalledWith(
        1,
        "call-code-mode-trusted-command",
        { command: "return 2;", code: "return 2;" },
        undefined,
        undefined,
      );
      expect(execute).toHaveBeenNthCalledWith(
        2,
        "call-code-mode-trusted-language",
        {
          code: "const value: number = 3;",
          command: "const value: number = 3;",
          language: "typescript",
        },
        undefined,
        undefined,
      );
      expect(
        consumeAdjustedParamsForToolCall("call-code-mode-trusted-command", "run-main"),
      ).toEqual({ command: "return 2;", code: "return 2;" });
      expect(
        consumeAdjustedParamsForToolCall("call-code-mode-trusted-language", "run-main"),
      ).toEqual({
        code: "const value: number = 3;",
        command: "const value: number = 3;",
        language: "typescript",
      });
    } finally {
      setActivePluginRegistry(createEmptyPluginRegistry());
      resetGlobalHookRunner();
    }
  });

  it("fires hook exactly once when tool goes through wrap + abort + toToolDefinitions", async () => {
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const baseTool = { name: "Bash", execute, description: "bash", parameters: {} } as any;

    const abortController = new AbortController();
    const wrapped = wrapToolWithBeforeToolCallHook(baseTool, {
      agentId: "main",
      sessionKey: "main",
    });
    const withAbort = wrapToolWithAbortSignal(wrapped, abortController.signal);
    const [def] = toToolDefinitions([withAbort]);
    const extensionContext = {} as Parameters<typeof def.execute>[4];

    await def.execute(
      "call-abort-dedup",
      { command: "ls" },
      undefined,
      undefined,
      extensionContext,
    );

    expect(beforeToolCallHook).toHaveBeenCalledTimes(1);
  });

  it("passes hook context for unwrapped tool definitions", async () => {
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const baseTool = { name: "exec", execute, description: "exec", parameters: {} } as any;
    const [def] = toToolDefinitions([baseTool], {
      agentId: "code-agent",
      sessionKey: "agent:code-agent:main",
      sessionId: "session-code",
      runId: "run-code",
      channelId: "channel-code",
    });
    const extensionContext = {} as Parameters<typeof def.execute>[4];

    await def.execute(
      "call-code-exec",
      { code: "echo hi" },
      undefined,
      undefined,
      extensionContext,
    );

    expect(beforeToolCallHook).toHaveBeenCalledTimes(1);
    expect(beforeToolCallHook).toHaveBeenCalledWith(
      {
        toolName: "exec",
        params: { code: "echo hi" },
        runId: "run-code",
        toolCallId: "call-code-exec",
      },
      {
        toolName: "exec",
        agentId: "code-agent",
        sessionKey: "agent:code-agent:main",
        sessionId: "session-code",
        runId: "run-code",
        toolCallId: "call-code-exec",
        channelId: "channel-code",
      },
    );
  });

  it("preserves the hook marker when abort wrapping a hooked tool", () => {
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const baseTool = { name: "Bash", execute, description: "bash", parameters: {} } as any;
    const wrapped = wrapToolWithBeforeToolCallHook(baseTool, {
      agentId: "main",
      sessionKey: "main",
    });
    const withAbort = wrapToolWithAbortSignal(wrapped, new AbortController().signal);

    expect(isToolWrappedWithBeforeToolCallHook(withAbort)).toBe(true);
  });
});

describe("before_tool_call hook integration for client tools", () => {
  beforeEach(() => {
    resetGlobalHookRunner();
    resetDiagnosticSessionStateForTest();
    installBeforeToolCallHook();
  });

  it("passes modified params to client tool callbacks", async () => {
    installBeforeToolCallHook({
      runBeforeToolCallImpl: async () => ({ params: { extra: true } }),
    });
    const onClientToolCall = vi.fn();
    const [tool] = toClientToolDefinitions(
      [
        {
          type: "function",
          function: {
            name: "client_tool",
            description: "Client tool",
            parameters: { type: "object", properties: { value: { type: "string" } } },
          },
        },
      ],
      onClientToolCall,
      { agentId: "main", sessionKey: "main" },
    );
    const extensionContext = {} as Parameters<typeof tool.execute>[4];
    await tool.execute("client-call-1", { value: "ok" }, undefined, undefined, extensionContext);

    expect(onClientToolCall).toHaveBeenCalledWith("client_tool", {
      value: "ok",
      extra: true,
    });
  });

  it("preserves client tool source order when hooks resolve out of order", async () => {
    let releaseFirstHook: (() => void) | undefined;
    const firstHookGate = new Promise<void>((resolve) => {
      releaseFirstHook = resolve;
    });
    installBeforeToolCallHook({
      runBeforeToolCallImpl: async (event: unknown) => {
        const toolName = (event as { toolName?: string }).toolName;
        if (toolName === "first_tool") {
          await firstHookGate;
        }
        return { params: { marker: toolName } };
      },
    });

    const slots: Array<{
      toolCallId: string;
      name: string;
      params?: Record<string, unknown>;
      completed: boolean;
    }> = [];
    const indexes = new Map<string, number>();
    const reserve = (toolCallId: string, name: string) => {
      indexes.set(toolCallId, slots.length);
      slots.push({ toolCallId, name, completed: false });
    };
    const complete = (toolCallId: string, name: string, params: Record<string, unknown>) => {
      const index = indexes.get(toolCallId);
      if (index === undefined) {
        throw new Error(`missing reserved client tool slot for ${toolCallId}`);
      }
      const slot = slots[index];
      if (!slot) {
        throw new Error(`missing client tool slot at ${index}`);
      }
      slot.name = name;
      slot.params = params;
      slot.completed = true;
    };
    const [firstTool, secondTool] = toClientToolDefinitions(
      [
        {
          type: "function",
          function: {
            name: "first_tool",
            description: "First client tool",
            parameters: { type: "object", properties: { value: { type: "string" } } },
          },
        },
        {
          type: "function",
          function: {
            name: "second_tool",
            description: "Second client tool",
            parameters: { type: "object", properties: { value: { type: "string" } } },
          },
        },
      ],
      { reserve, complete },
      { agentId: "main", sessionKey: "main" },
    );
    if (!firstTool || !secondTool) {
      throw new Error("missing client tool definitions");
    }
    const extensionContext = {} as Parameters<typeof firstTool.execute>[4];

    const firstRun = firstTool.execute(
      "client-call-1",
      { value: "first" },
      undefined,
      undefined,
      extensionContext,
    );
    const secondRun = secondTool.execute(
      "client-call-2",
      { value: "second" },
      undefined,
      undefined,
      extensionContext,
    );

    await secondRun;
    expect(slots.map((slot) => ({ name: slot.name, completed: slot.completed }))).toEqual([
      { name: "first_tool", completed: false },
      { name: "second_tool", completed: true },
    ]);

    if (!releaseFirstHook) {
      throw new Error("Expected first before-tool-call hook release callback to be initialized");
    }
    releaseFirstHook();
    await firstRun;

    expect(
      collectMatching(
        slots,
        (slot) => slot.completed,
        (slot) => slot.name,
      ),
    ).toEqual(["first_tool", "second_tool"]);
    expect(slots.map((slot) => slot.params)).toEqual([
      { value: "first", marker: "first_tool" },
      { value: "second", marker: "second_tool" },
    ]);
  });

  it("lets trusted policies read session extensions for client tools when config is provided", async () => {
    resetGlobalHookRunner();
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-client-tool-policy-"));
    const storePath = path.join(stateDir, "sessions.json");
    const config = { session: { store: storePath } };
    const seen: unknown[] = [];
    const registry = createEmptyPluginRegistry();
    registry.sessionExtensions = [
      {
        pluginId: "policy-plugin",
        pluginName: "Policy Plugin",
        source: "test",
        extension: {
          namespace: "policy",
          description: "policy state",
        },
      },
    ];
    registry.trustedToolPolicies = [
      {
        pluginId: "policy-plugin",
        pluginName: "Policy Plugin",
        source: "test",
        policy: {
          id: "client-tool-session-extension-policy",
          description: "client tool session extension policy",
          evaluate(eventValue, ctx) {
            seen.push(ctx.getSessionExtension?.("policy"));
            return undefined;
          },
        },
      },
    ];
    setActivePluginRegistry(registry);
    try {
      await updateSessionStore(storePath, (store) => {
        store["agent:main:client"] = {
          sessionId: "session-client",
          updatedAt: Date.now(),
        } as SessionEntry;
      });
      await expect(
        patchPluginSessionExtension({
          cfg: config as never,
          sessionKey: "agent:main:client",
          pluginId: "policy-plugin",
          namespace: "policy",
          value: { gate: "client" },
        }),
      ).resolves.toEqual({
        ok: true,
        key: "agent:main:client",
        value: { gate: "client" },
      });

      const [tool] = toClientToolDefinitions(
        [
          {
            type: "function",
            function: {
              name: "client_tool",
              description: "Client tool",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
        undefined,
        {
          agentId: "main",
          sessionKey: "agent:main:client",
          sessionId: "session-client",
          config: config as never,
        },
      );
      const extensionContext = {} as Parameters<typeof tool.execute>[4];
      await tool.execute("client-call-policy", {}, undefined, undefined, extensionContext);

      expect(seen).toEqual([{ gate: "client" }]);
    } finally {
      setActivePluginRegistry(createEmptyPluginRegistry());
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});
