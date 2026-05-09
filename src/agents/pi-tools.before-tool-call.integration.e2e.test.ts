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
import { toClientToolDefinitions, toToolDefinitions } from "./pi-tool-definition-adapter.js";
import { wrapToolWithAbortSignal } from "./pi-tools.abort.js";
import {
  __testing as beforeToolCallTesting,
  consumeAdjustedParamsForToolCall,
  wrapToolWithBeforeToolCallHook,
} from "./pi-tools.before-tool-call.js";

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
          evaluate(_event, ctx) {
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
      ).resolves.toMatchObject({ ok: true });

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
