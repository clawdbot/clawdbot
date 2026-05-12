import { describe, expect, it, vi } from "vitest";
import { setPluginToolMeta } from "../plugins/tools.js";
import { wrapToolWithAbortSignal } from "./pi-tools.abort.js";
import {
  isToolWrappedWithBeforeToolCallHook,
  wrapToolWithBeforeToolCallHook,
} from "./pi-tools.before-tool-call.js";
import {
  __testing,
  addClientToolsToToolSearchCatalog,
  applyToolSearchCatalog,
  clearToolSearchCatalog,
  createToolSearchCatalogRef,
  createToolSearchTools,
  projectToolSearchTargetTranscriptMessages,
  TOOL_CALL_RAW_TOOL_NAME,
  TOOL_DESCRIBE_RAW_TOOL_NAME,
  TOOL_SEARCH_CODE_MODE_TOOL_NAME,
  TOOL_SEARCH_RAW_TOOL_NAME,
} from "./tool-search.js";
import { jsonResult, type AnyAgentTool } from "./tools/common.js";

function fakeTool(name: string, description: string): AnyAgentTool {
  return {
    name,
    label: name,
    description,
    parameters: {
      type: "object",
      properties: {
        value: { type: "string" },
      },
    },
    execute: vi.fn(async (_toolCallId, input) => jsonResult({ name, input })),
  };
}

function pluginTool(name: string, description: string, pluginId = "fake-catalog"): AnyAgentTool {
  const tool = fakeTool(name, description);
  setPluginToolMeta(tool, {
    pluginId,
    optional: true,
  });
  return tool;
}

function resultDetails(result: { details?: unknown }): Record<string, unknown> {
  if (!result.details || typeof result.details !== "object") {
    throw new Error("Expected result details");
  }
  return result.details as Record<string, unknown>;
}

function mockCall(mock: { mock: { calls: unknown[][] } }, index = 0): unknown[] {
  const call = mock.mock.calls[index];
  if (!call) {
    throw new Error(`Expected mock call ${index}`);
  }
  return call;
}

describe("Tool Search", () => {
  it("enables object config when a mode is set", () => {
    const resolved = __testing.resolveToolSearchConfig({
      tools: {
        toolSearch: {
          mode: "tools",
        },
      },
    } as never);
    expect(resolved.enabled).toBe(true);
    expect(resolved.mode).toBe("tools");
  });

  it("falls back to structured controls when code mode is unsupported", () => {
    __testing.setToolSearchCodeModeSupportedForTest(false);
    try {
      const config = { tools: { toolSearch: true } } as never;
      const resolved = __testing.resolveToolSearchConfig(config);
      const compacted = applyToolSearchCatalog({
        tools: [
          fakeTool(TOOL_SEARCH_CODE_MODE_TOOL_NAME, "code mode"),
          fakeTool(TOOL_SEARCH_RAW_TOOL_NAME, "search"),
          fakeTool(TOOL_DESCRIBE_RAW_TOOL_NAME, "describe"),
          fakeTool(TOOL_CALL_RAW_TOOL_NAME, "call"),
          pluginTool("fake_bun_fallback", "Fallback target"),
        ],
        config,
        sessionId: "session-code-unsupported",
      });

      expect(resolved.mode).toBe("tools");
      expect(compacted.tools.map((tool) => tool.name)).toEqual([
        TOOL_SEARCH_RAW_TOOL_NAME,
        TOOL_DESCRIBE_RAW_TOOL_NAME,
        TOOL_CALL_RAW_TOOL_NAME,
      ]);
      expect(compacted.catalogToolCount).toBe(1);
    } finally {
      __testing.setToolSearchCodeModeSupportedForTest(undefined);
    }
  });

  it("compacts plugin tools behind the code surface and can search, describe, and call them", async () => {
    const codeTool = fakeTool(TOOL_SEARCH_CODE_MODE_TOOL_NAME, "code mode");
    const alpha = pluginTool("fake_create_ticket", "Create a ticket in the fake tracker");
    const beta = pluginTool("fake_weather", "Read fake weather");

    const compacted = applyToolSearchCatalog({
      tools: [codeTool, alpha, beta],
      config: {
        tools: {
          toolSearch: true,
        },
      } as never,
      sessionId: "session-1",
      sessionKey: "agent:main:main",
    });

    expect(compacted.tools.map((tool) => tool.name)).toEqual([TOOL_SEARCH_CODE_MODE_TOOL_NAME]);
    expect(compacted.catalogToolCount).toBe(2);

    const [runtimeCodeTool] = createToolSearchTools({
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      config: compacted.tools[0] ? {} : undefined,
    });
    const result = await runtimeCodeTool.execute("call-1", {
      code: `
        const hits = await openclaw.tools.search("ticket", { limit: 1 });
        const described = await openclaw.tools.describe(hits[0].id);
        return await openclaw.tools.call(described.id, { value: "ship" });
      `,
    });

    const alphaCall = mockCall(vi.mocked(alpha.execute));
    expect(alphaCall[0]).toBe("tool_search_code:call-1:fake_create_ticket:1");
    expect(alphaCall[1]).toEqual({ value: "ship" });
    expect(alphaCall[2]).toBeInstanceOf(AbortSignal);
    expect(alphaCall[3]).toBeUndefined();
    expect(alphaCall[4]).toBeUndefined();
    const details = resultDetails(result);
    expect(details.ok).toBe(true);
    const telemetry = details.telemetry as {
      catalogSize?: number;
      searchCount?: number;
      describeCount?: number;
      callCount?: number;
    };
    expect(telemetry.catalogSize).toBe(2);
    expect(telemetry.searchCount).toBe(1);
    expect(telemetry.describeCount).toBe(1);
    expect(telemetry.callCount).toBe(1);
  });

  it("scopes catalogs by run id when attempts share a session", async () => {
    const runATool = pluginTool("fake_run_a", "Tool visible only to run A");
    const runBTool = pluginTool("fake_run_b", "Tool visible only to run B");
    const config = {
      tools: {
        toolSearch: true,
      },
    } as never;

    applyToolSearchCatalog({
      tools: [fakeTool(TOOL_SEARCH_CODE_MODE_TOOL_NAME, "code mode"), runATool],
      config,
      sessionId: "session-overlap",
      sessionKey: "agent:main:main",
      runId: "run-a",
    });
    applyToolSearchCatalog({
      tools: [fakeTool(TOOL_SEARCH_CODE_MODE_TOOL_NAME, "code mode"), runBTool],
      config,
      sessionId: "session-overlap",
      sessionKey: "agent:main:main",
      runId: "run-b",
    });

    const [, , , runACallTool] = createToolSearchTools({
      sessionId: "session-overlap",
      sessionKey: "agent:main:main",
      runId: "run-a",
      config,
    });
    await runACallTool.execute("call-run-a", {
      id: "fake_run_a",
      args: { value: "A" },
    });
    await expect(
      runACallTool.execute("call-run-a-miss", {
        id: "fake_run_b",
        args: { value: "B" },
      }),
    ).rejects.toThrow("Unknown tool id: fake_run_b");

    clearToolSearchCatalog({
      sessionId: "session-overlap",
      sessionKey: "agent:main:main",
      runId: "run-a",
    });
    expect(__testing.sessionCatalogs.has("run:run-a")).toBe(false);
    expect(__testing.sessionCatalogs.has("run:run-b")).toBe(true);
    expect(runATool.execute).toHaveBeenCalledTimes(1);
    expect(runBTool.execute).not.toHaveBeenCalled();
    clearToolSearchCatalog({ runId: "run-b" });
  });

  it("uses the runtime-local catalog ref before the shared catalog registry", async () => {
    const localRef = createToolSearchCatalogRef();
    const localTool = pluginTool("fake_local_ref", "Tool visible through the local ref");
    const globalTool = pluginTool("fake_global_ref", "Tool visible through the registry fallback");
    const config = { tools: { toolSearch: true } } as never;

    applyToolSearchCatalog({
      tools: [fakeTool(TOOL_SEARCH_CODE_MODE_TOOL_NAME, "code mode"), localTool],
      config,
      sessionId: "session-catalog-ref",
      runId: "run-local-ref",
      catalogRef: localRef,
    });
    applyToolSearchCatalog({
      tools: [fakeTool(TOOL_SEARCH_CODE_MODE_TOOL_NAME, "code mode"), globalTool],
      config,
      sessionId: "session-catalog-ref",
    });

    const [, , , callTool] = createToolSearchTools({
      sessionId: "session-catalog-ref",
      runId: "run-local-ref",
      catalogRef: localRef,
      config,
    });
    await callTool.execute("call-local-ref", {
      id: "fake_local_ref",
      args: { value: "local" },
    });
    await expect(
      callTool.execute("call-global-ref", {
        id: "fake_global_ref",
        args: { value: "global" },
      }),
    ).rejects.toThrow("Unknown tool id: fake_global_ref");

    expect(localTool.execute).toHaveBeenCalledTimes(1);
    expect(globalTool.execute).not.toHaveBeenCalled();
    clearToolSearchCatalog({ runId: "run-local-ref", catalogRef: localRef });
    clearToolSearchCatalog({ sessionId: "session-catalog-ref" });
  });

  it("keeps raw fallback tools and hides the code tool in tools mode", () => {
    const codeTool = fakeTool(TOOL_SEARCH_CODE_MODE_TOOL_NAME, "code mode");
    const searchTool = fakeTool(TOOL_SEARCH_RAW_TOOL_NAME, "search");
    const describeTool = fakeTool(TOOL_DESCRIBE_RAW_TOOL_NAME, "describe");
    const callTool = fakeTool(TOOL_CALL_RAW_TOOL_NAME, "call");
    const target = pluginTool("fake_lookup", "Lookup fake records");

    const compacted = applyToolSearchCatalog({
      tools: [codeTool, searchTool, describeTool, callTool, target],
      config: {
        tools: {
          toolSearch: { enabled: true, mode: "tools" },
        },
      } as never,
      sessionId: "session-raw",
    });

    expect(compacted.tools.map((tool) => tool.name)).toEqual([
      TOOL_SEARCH_RAW_TOOL_NAME,
      TOOL_DESCRIBE_RAW_TOOL_NAME,
      TOOL_CALL_RAW_TOOL_NAME,
    ]);
    expect(compacted.catalogToolCount).toBe(1);
  });

  it("drops inactive controls when the selected Tool Search control is unavailable", () => {
    const searchTool = fakeTool(TOOL_SEARCH_RAW_TOOL_NAME, "search");
    const describeTool = fakeTool(TOOL_DESCRIBE_RAW_TOOL_NAME, "describe");
    const callTool = fakeTool(TOOL_CALL_RAW_TOOL_NAME, "call");
    const target = pluginTool("fake_lookup_direct", "Lookup fake records directly");

    const compacted = applyToolSearchCatalog({
      tools: [searchTool, describeTool, callTool, target],
      config: {
        tools: {
          toolSearch: true,
        },
      } as never,
      sessionId: "session-code-control-denied",
    });

    expect(compacted.tools.map((tool) => tool.name)).toEqual(["fake_lookup_direct"]);
    expect(compacted.catalogRegistered).toBe(false);
    expect(compacted.catalogToolCount).toBe(0);
  });

  it("moves client tools into the same catalog when a session catalog exists", () => {
    const codeTool = fakeTool(TOOL_SEARCH_CODE_MODE_TOOL_NAME, "code mode");
    const config = {
      tools: {
        toolSearch: true,
      },
    } as never;
    applyToolSearchCatalog({
      tools: [codeTool],
      config,
      sessionId: "session-client",
    });

    const clientTool = fakeTool("client_pick_file", "Ask the client to pick a file");
    const compacted = addClientToolsToToolSearchCatalog({
      tools: [clientTool],
      config,
      sessionId: "session-client",
    });

    expect(compacted.tools).toEqual([]);
    expect(compacted.catalogToolCount).toBe(1);
    const clientEntry = __testing.sessionCatalogs
      .get("session:session-client")
      ?.entries.find((entry) => entry.id === "client:client:client_pick_file");
    expect(clientEntry?.source).toBe("client");
  });

  it("wraps cataloged OpenClaw tools with before_tool_call hooks", async () => {
    const codeTool = fakeTool(TOOL_SEARCH_CODE_MODE_TOOL_NAME, "code mode");
    const target = pluginTool("fake_hooked", "Run a hook-aware fake tool");

    applyToolSearchCatalog({
      tools: [codeTool, target],
      config: { tools: { toolSearch: true } } as never,
      sessionId: "session-hooks",
      toolHookContext: {
        agentId: "agent-main",
        sessionId: "session-hooks",
        sessionKey: "agent:main:main",
      },
    });

    const entry = __testing.sessionCatalogs
      .get("session:session-hooks")
      ?.entries.find((candidate) => candidate.name === "fake_hooked");
    if (!entry) {
      throw new Error("Expected fake_hooked catalog entry");
    }
    expect(isToolWrappedWithBeforeToolCallHook(entry.tool as AnyAgentTool)).toBe(true);

    const [runtimeCodeTool] = createToolSearchTools({
      sessionId: "session-hooks",
      sessionKey: "agent:main:main",
      config: {},
    });
    await runtimeCodeTool.execute("call-hooks", {
      code: `return await openclaw.tools.call("fake_hooked", { value: "ok" });`,
    });
    const targetCall = mockCall(vi.mocked(target.execute));
    expect(targetCall[0]).toBe("tool_search_code:call-hooks:fake_hooked:1");
    expect(targetCall[1]).toEqual({ value: "ok" });
    expect(targetCall[2]).toBeInstanceOf(AbortSignal);
    expect(targetCall[3]).toBeUndefined();
  });

  it("does not re-wrap abort-wrapped tools that already have before_tool_call hooks", () => {
    const codeTool = fakeTool(TOOL_SEARCH_CODE_MODE_TOOL_NAME, "code mode");
    const target = pluginTool("fake_already_hooked", "Already hook-aware fake tool");
    const hooked = wrapToolWithBeforeToolCallHook(target, {
      agentId: "agent-main",
      sessionId: "session-hooks-abort",
      sessionKey: "agent:main:main",
    });
    const abortWrapped = wrapToolWithAbortSignal(hooked, new AbortController().signal);

    applyToolSearchCatalog({
      tools: [codeTool, abortWrapped],
      config: { tools: { toolSearch: true } } as never,
      sessionId: "session-hooks-abort",
      toolHookContext: {
        agentId: "agent-main",
        sessionId: "session-hooks-abort",
        sessionKey: "agent:main:main",
      },
    });

    const entry = __testing.sessionCatalogs
      .get("session:session-hooks-abort")
      ?.entries.find((candidate) => candidate.name === "fake_already_hooked");
    expect(entry?.tool).toBe(abortWrapped);
    expect(isToolWrappedWithBeforeToolCallHook(entry!.tool as AnyAgentTool)).toBe(true);
  });

  it("uses a unique bridged tool call id for repeated calls", async () => {
    const codeTool = fakeTool(TOOL_SEARCH_CODE_MODE_TOOL_NAME, "code mode");
    const target = pluginTool("fake_repeated", "Run a repeated fake tool");

    applyToolSearchCatalog({
      tools: [codeTool, target],
      config: { tools: { toolSearch: true } } as never,
      sessionId: "session-repeated",
      sessionKey: "agent:main:main",
    });

    const [runtimeCodeTool] = createToolSearchTools({
      sessionId: "session-repeated",
      sessionKey: "agent:main:main",
      config: {},
    });
    await runtimeCodeTool.execute("call-repeated", {
      code: `
        await openclaw.tools.call("fake_repeated", { value: "one" });
        return await openclaw.tools.call("fake_repeated", { value: "two" });
      `,
    });

    const firstCall = mockCall(vi.mocked(target.execute));
    expect(firstCall[0]).toBe("tool_search_code:call-repeated:fake_repeated:1");
    expect(firstCall[1]).toEqual({ value: "one" });
    expect(firstCall[2]).toBeInstanceOf(AbortSignal);
    expect(firstCall[3]).toBeUndefined();
    expect(firstCall[4]).toBeUndefined();
    const secondCall = mockCall(vi.mocked(target.execute), 1);
    expect(secondCall[0]).toBe("tool_search_code:call-repeated:fake_repeated:2");
    expect(secondCall[1]).toEqual({ value: "two" });
    expect(secondCall[2]).toBeInstanceOf(AbortSignal);
    expect(secondCall[3]).toBeUndefined();
    expect(secondCall[4]).toBeUndefined();
    await runtimeCodeTool.execute("call-repeated-again", {
      code: `return await openclaw.tools.call("fake_repeated", { value: "three" });`,
    });

    const thirdCall = mockCall(vi.mocked(target.execute), 2);
    expect(thirdCall[0]).toBe("tool_search_code:call-repeated-again:fake_repeated:1");
    expect(thirdCall[1]).toEqual({ value: "three" });
    expect(thirdCall[2]).toBeInstanceOf(AbortSignal);
    expect(thirdCall[3]).toBeUndefined();
    expect(thirdCall[4]).toBeUndefined();
  });

  it("routes bridged calls through the configured catalog executor", async () => {
    const codeTool = fakeTool(TOOL_SEARCH_CODE_MODE_TOOL_NAME, "code mode");
    const target = pluginTool("fake_lifecycle", "Run through lifecycle executor");
    const abortController = new AbortController();
    const onUpdate = vi.fn();
    const executeTool = vi.fn(async () => jsonResult({ status: "ok" }));

    applyToolSearchCatalog({
      tools: [codeTool, target],
      config: { tools: { toolSearch: true } } as never,
      sessionId: "session-lifecycle",
      sessionKey: "agent:main:main",
    });

    const [runtimeCodeTool, , , runtimeCallTool] = createToolSearchTools({
      sessionId: "session-lifecycle",
      sessionKey: "agent:main:main",
      config: {},
      abortSignal: abortController.signal,
      executeTool,
    });
    await runtimeCodeTool.execute(
      "call-lifecycle",
      {
        code: `return await openclaw.tools.call("fake_lifecycle", { value: "ok" });`,
      },
      undefined,
      onUpdate,
    );

    expect(target.execute).not.toHaveBeenCalled();
    const firstExecuteInput = mockCall(executeTool)[0] as {
      tool?: { name?: string };
      toolName?: string;
      toolCallId?: string;
      parentToolCallId?: string;
      input?: unknown;
      signal?: unknown;
      onUpdate?: unknown;
    };
    expect(firstExecuteInput.tool?.name).toBe("fake_lifecycle");
    expect(firstExecuteInput.toolName).toBe("fake_lifecycle");
    expect(firstExecuteInput.toolCallId).toBe("tool_search_code:call-lifecycle:fake_lifecycle:1");
    expect(firstExecuteInput.parentToolCallId).toBe("call-lifecycle");
    expect(firstExecuteInput.input).toEqual({ value: "ok" });
    expect(firstExecuteInput.signal).toBeInstanceOf(AbortSignal);
    expect(firstExecuteInput.onUpdate).toBe(onUpdate);

    await runtimeCallTool.execute(
      "call-lifecycle-structured",
      {
        id: "fake_lifecycle",
        args: { value: "structured" },
      },
      abortController.signal,
      onUpdate,
    );

    expect(target.execute).not.toHaveBeenCalled();
    const secondExecuteInput = mockCall(executeTool, 1)[0] as {
      tool?: { name?: string };
      toolName?: string;
      toolCallId?: string;
      parentToolCallId?: string;
      input?: unknown;
      signal?: unknown;
      onUpdate?: unknown;
    };
    expect(secondExecuteInput.tool?.name).toBe("fake_lifecycle");
    expect(secondExecuteInput.toolName).toBe("fake_lifecycle");
    expect(secondExecuteInput.toolCallId).toBe(
      "tool_search_code:call-lifecycle-structured:fake_lifecycle:1",
    );
    expect(secondExecuteInput.parentToolCallId).toBe("call-lifecycle-structured");
    expect(secondExecuteInput.input).toEqual({ value: "structured" });
    expect(secondExecuteInput.signal).toBe(abortController.signal);
    expect(secondExecuteInput.onUpdate).toBe(onUpdate);
  });

  it("projects target tool calls after their Tool Search wrapper result", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "wrapper-call",
            name: TOOL_CALL_RAW_TOOL_NAME,
            arguments: { id: "fake_target", args: { value: "ok" } },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "wrapper-call",
        toolName: TOOL_CALL_RAW_TOOL_NAME,
        content: [{ type: "text", text: "wrapped" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
      },
    ];

    const projected = projectToolSearchTargetTranscriptMessages(messages as never, [
      {
        parentToolCallId: "wrapper-call",
        toolCallId: "tool_search_code:wrapper-call:fake_target:1",
        toolName: "fake_target",
        input: { value: "ok" },
        result: jsonResult({ ok: true }),
        timestamp: 123,
      },
    ]);

    expect(projected).toHaveLength(5);
    const projectedToolCall = projected[2] as {
      role?: string;
      content?: Array<{
        type?: string;
        id?: string;
        name?: string;
        arguments?: unknown;
        input?: unknown;
      }>;
    };
    expect(projectedToolCall.role).toBe("assistant");
    expect(projectedToolCall.content).toEqual([
      {
        type: "toolCall",
        id: "tool_search_code:wrapper-call:fake_target:1",
        name: "fake_target",
        arguments: { value: "ok" },
        input: { value: "ok" },
      },
    ]);
    const projectedToolResult = projected[3] as {
      role?: string;
      toolCallId?: string;
      toolName?: string;
      isError?: boolean;
      content?: unknown;
    };
    expect(projectedToolResult.role).toBe("toolResult");
    expect(projectedToolResult.toolCallId).toBe("tool_search_code:wrapper-call:fake_target:1");
    expect(projectedToolResult.toolName).toBe("fake_target");
    expect(projectedToolResult.isError).toBe(false);
    expect(projectedToolResult.content).toEqual([
      { type: "text", text: JSON.stringify({ ok: true }, null, 2) },
    ]);
    expect(projected[4]).toBe(messages[2]);
  });

  it("does not execute fire-and-forget bridged calls after code returns", async () => {
    const codeTool = fakeTool(TOOL_SEARCH_CODE_MODE_TOOL_NAME, "code mode");
    const target = pluginTool("fake_fire_and_forget", "Should not run unless awaited");

    applyToolSearchCatalog({
      tools: [codeTool, target],
      config: { tools: { toolSearch: true } } as never,
      sessionId: "session-fire-and-forget",
      sessionKey: "agent:main:main",
    });

    const [runtimeCodeTool] = createToolSearchTools({
      sessionId: "session-fire-and-forget",
      sessionKey: "agent:main:main",
      config: {},
    });
    const result = await runtimeCodeTool.execute("call-fire-and-forget", {
      code: `
        openclaw.tools.call("fake_fire_and_forget", { value: "late" });
        return "done";
      `,
    });

    expect(target.execute).not.toHaveBeenCalled();
    const details = resultDetails(result);
    expect(details.ok).toBe(true);
    expect(details.value).toBe("done");
    expect((details.telemetry as { callCount?: number }).callCount).toBe(0);
  });

  it("waits for started bridged calls before returning code-mode success", async () => {
    const codeTool = fakeTool(TOOL_SEARCH_CODE_MODE_TOOL_NAME, "code mode");
    const target = pluginTool("fake_then_started", "Started by .then without await");
    let resolveTool: (() => void) | undefined;
    target.execute = vi.fn(
      async (_toolCallId: string, input: unknown): Promise<ReturnType<typeof jsonResult>> => {
        await new Promise<void>((resolve) => {
          resolveTool = resolve;
        });
        return jsonResult({ name: target.name, input });
      },
    );

    applyToolSearchCatalog({
      tools: [codeTool, target],
      config: { tools: { toolSearch: true } } as never,
      sessionId: "session-started-bridge",
      sessionKey: "agent:main:main",
    });

    const [runtimeCodeTool] = createToolSearchTools({
      sessionId: "session-started-bridge",
      sessionKey: "agent:main:main",
      config: {},
    });
    let settled = false;
    const resultPromise = runtimeCodeTool
      .execute("call-started-bridge", {
        code: `
          openclaw.tools.call("fake_then_started", { value: "started" }).then(() => {});
          return "done";
        `,
      })
      .then((result) => {
        settled = true;
        return result;
      });

    await vi.waitFor(() => expect(target.execute).toHaveBeenCalledTimes(1));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    resolveTool?.();
    const result = await resultPromise;

    const details = resultDetails(result);
    expect(details.ok).toBe(true);
    expect(details.value).toBe("done");
    expect((details.telemetry as { callCount?: number }).callCount).toBe(1);
  });

  it("does not expose the host process to model-authored code", async () => {
    const [runtimeCodeTool] = createToolSearchTools({
      sessionId: "session-escape",
      sessionKey: "agent:main:main",
      config: {},
    });

    await expect(
      runtimeCodeTool.execute("call-escape", {
        code: `return Function("return process")();`,
      }),
    ).rejects.toThrow();
    await expect(
      runtimeCodeTool.execute("call-constructor-escape", {
        code: `return globalThis.constructor.constructor("return process")();`,
      }),
    ).rejects.toThrow();
    await expect(
      runtimeCodeTool.execute("call-console-escape", {
        code: `return console.log.constructor.constructor("return process")();`,
      }),
    ).rejects.toThrow();
    await expect(
      runtimeCodeTool.execute("call-bridge-escape", {
        code: `return openclaw.tools.call.constructor.constructor("return process")();`,
      }),
    ).rejects.toThrow();
  });

  it("preserves code-mode bridge errors from the child process", async () => {
    const codeTool = fakeTool(TOOL_SEARCH_CODE_MODE_TOOL_NAME, "code mode");
    applyToolSearchCatalog({
      tools: [codeTool],
      config: { tools: { toolSearch: true } } as never,
      sessionId: "session-missing-tool-error",
      sessionKey: "agent:main:main",
    });

    const [runtimeCodeTool] = createToolSearchTools({
      sessionId: "session-missing-tool-error",
      sessionKey: "agent:main:main",
      config: {},
    });

    await expect(
      runtimeCodeTool.execute("call-missing-tool", {
        code: `return await openclaw.tools.call("missing_tool", {});`,
      }),
    ).rejects.toThrow("Unknown tool id: missing_tool");
  });

  it("does not expose host-realm bridge result objects to model-authored code", async () => {
    const codeTool = fakeTool(TOOL_SEARCH_CODE_MODE_TOOL_NAME, "code mode");
    const target = pluginTool("fake_bridge_result_escape", "Target for bridge result escape");

    applyToolSearchCatalog({
      tools: [codeTool, target],
      config: { tools: { toolSearch: true } } as never,
      sessionId: "session-bridge-result-escape",
      sessionKey: "agent:main:main",
    });

    const [runtimeCodeTool] = createToolSearchTools({
      sessionId: "session-bridge-result-escape",
      sessionKey: "agent:main:main",
      config: {},
    });

    await expect(
      runtimeCodeTool.execute("call-bridge-result-escape", {
        code: `
          const hits = await openclaw.tools.search("bridge result", { limit: 1 });
          return hits.constructor.constructor("return process")();
        `,
      }),
    ).rejects.toThrow();
    expect(target.execute).not.toHaveBeenCalled();
  });

  it("does not let model-authored code access bridge controller locals", async () => {
    const codeTool = fakeTool(TOOL_SEARCH_CODE_MODE_TOOL_NAME, "code mode");
    const target = pluginTool("fake_controller_escape", "Target for forged bridge request");

    applyToolSearchCatalog({
      tools: [codeTool, target],
      config: { tools: { toolSearch: true } } as never,
      sessionId: "session-controller-escape",
      sessionKey: "agent:main:main",
    });

    const [runtimeCodeTool] = createToolSearchTools({
      sessionId: "session-controller-escape",
      sessionKey: "agent:main:main",
      config: {},
    });

    await expect(
      runtimeCodeTool.execute("call-controller-escape", {
        code: `
          })(openclaw, console),
          bridgeMessages.push({
            id: "forged",
            method: "call",
            args: ["fake_controller_escape", { value: "forged" }],
          }),
          (async (openclaw, console) => {
            return "done";
        `,
      }),
    ).rejects.toThrow();
    expect(target.execute).not.toHaveBeenCalled();
  });

  it("terminates async continuations that block the event loop after a bridge call", async () => {
    const codeTool = fakeTool(TOOL_SEARCH_CODE_MODE_TOOL_NAME, "code mode");
    const alpha = pluginTool("fake_timeout_target", "Target tool for timeout search");

    const config = {
      tools: {
        toolSearch: { enabled: true, mode: "code", codeTimeoutMs: 1000 },
      },
    } as never;

    applyToolSearchCatalog({
      tools: [codeTool, alpha],
      config,
      sessionId: "session-timeout",
      sessionKey: "agent:main:main",
    });

    const [runtimeCodeTool] = createToolSearchTools({
      sessionId: "session-timeout",
      sessionKey: "agent:main:main",
      config,
    });

    await expect(
      runtimeCodeTool.execute("call-timeout", {
        code: `
            await openclaw.tools.search("timeout", { limit: 1 });
            while (true) {}
          `,
      }),
    ).rejects.toThrow("tool_search_code timed out");
  }, 5_000);

  it("aborts already-started bridged calls when code mode times out", async () => {
    const codeTool = fakeTool(TOOL_SEARCH_CODE_MODE_TOOL_NAME, "code mode");
    const target = pluginTool("fake_abort_on_timeout", "Long-running target tool");
    let observedSignal: AbortSignal | undefined;
    let abortCount = 0;
    target.execute = vi.fn(
      async (
        _toolCallId: string,
        _input: unknown,
        signal?: AbortSignal,
      ): Promise<ReturnType<typeof jsonResult>> => {
        observedSignal = signal;
        await new Promise<void>((resolve) => {
          if (signal?.aborted) {
            abortCount += 1;
            resolve();
            return;
          }
          signal?.addEventListener(
            "abort",
            () => {
              abortCount += 1;
              resolve();
            },
            { once: true },
          );
        });
        return jsonResult({ aborted: true });
      },
    );

    const config = {
      tools: {
        toolSearch: { enabled: true, mode: "code", codeTimeoutMs: 100 },
      },
    } as never;
    applyToolSearchCatalog({
      tools: [codeTool, target],
      config,
      sessionId: "session-abort-timeout",
      sessionKey: "agent:main:main",
    });

    const [runtimeCodeTool] = createToolSearchTools({
      sessionId: "session-abort-timeout",
      sessionKey: "agent:main:main",
      config,
    });

    await expect(
      runtimeCodeTool.execute("call-abort-timeout", {
        code: `return await openclaw.tools.call("fake_abort_on_timeout", { value: "wait" });`,
      }),
    ).rejects.toThrow("tool_search_code timed out");
    if (!observedSignal) {
      throw new Error("Expected observed abort signal");
    }
    expect(observedSignal.aborted).toBe(true);
    expect(abortCount).toBe(1);
  });
});
