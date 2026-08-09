/**
 * End-to-end coverage for before_tool_call hook integration.
 * Exercises runtime wrapping, client-tool adaptation, code-mode params, and
 * adjusted parameter handoff across the tool boundary.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import {
  getDiagnosticSessionState,
  resetDiagnosticSessionStateForTest,
} from "../logging/diagnostic-session-state.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { addTestHook, createMockPluginRegistry } from "../plugins/hooks.test-fixtures.js";
import { patchPluginSessionExtension } from "../plugins/host-hook-state.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { setPluginToolMeta } from "../plugins/tools.js";
import type { PluginHookRegistration } from "../plugins/types.js";
import {
  authorizeClientVoiceConfirmation,
  bindAuthorizedClientVoiceConfirmation,
  checkClientVoiceToolConfirmationPolicy,
  noteClientVoiceConfirmationUtterance,
} from "../talk/client-voice-confirmation.js";
import { resetClientVoiceConfirmationStateForTest } from "../talk/client-voice-confirmation.test-support.js";
import * as clientVoiceSession from "../talk/client-voice-session.js";
import { toClientToolDefinitions, toToolDefinitions } from "./agent-tool-definition-adapter.js";
import { wrapToolWithAbortSignal } from "./agent-tools.abort.js";
import {
  consumeAdjustedParamsForToolCall,
  consumePreExecutionBlockedToolCall,
  finalizeToolTerminalPresentation,
  isToolWrappedWithBeforeToolCallHook,
  wrapToolWithBeforeToolCallHook,
} from "./agent-tools.before-tool-call.js";
import {
  adjustedParamsByToolCallId,
  buildAdjustedParamsKey,
  consumeTrackedToolExecutionStarted,
  resetAdjustedParamsByToolCallIdForTests,
  structuredReplaySafeToolCallIds,
} from "./agent-tools.before-tool-call.state.js";
import { normalizeToolParameters } from "./agent-tools.schema.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { markCodeModeControlTool } from "./code-mode-control-tools.js";
import { CODE_MODE_EXEC_TOOL_NAME, createCodeModeTools } from "./code-mode.js";
import { splitSdkTools } from "./embedded-agent-runner/tool-split.js";
import { getInternalToolExecutionPreparer } from "./runtime/internal-hooks.js";
import type { ExtensionContext } from "./sessions/index.js";
import { wrapToolDefinition } from "./sessions/tools/tool-definition-wrapper.js";
import { hashToolCall, recordToolCall } from "./tool-loop-detection.js";
import { setToolTerminalPresentation } from "./tool-terminal-presentation.js";

type BeforeToolCallHandlerMock = ReturnType<typeof vi.fn>;

const beforeToolCallTesting = {
  adjustedParamsByToolCallId,
  buildAdjustedParamsKey,
  structuredReplaySafeToolCallIds,
};

function asAgentTool(tool: {
  description?: string;
  execute: ReturnType<typeof vi.fn>;
  name: string;
  parameters?: object;
  resultContentSource?: AnyAgentTool["resultContentSource"];
}): AnyAgentTool {
  return tool as unknown as AnyAgentTool;
}

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

function installVoiceRunBinding(runId: string): void {
  const binding = {
    agentId: "main",
    voiceSessionId: `voice-${runId}`,
    sessionKey: "agent:main:voice",
  };
  vi.spyOn(clientVoiceSession, "resolveClientVoiceRunBinding").mockImplementation(
    (candidateRunId) => (candidateRunId === runId ? binding : undefined),
  );
  vi.spyOn(clientVoiceSession, "isClientVoiceSessionConfirmable").mockReturnValue(true);
}

function approveVoiceToolParams(runId: string, toolParams: unknown): void {
  const voiceSessionId = `voice-${runId}`;
  const now = Date.now();
  const challenge = checkClientVoiceToolConfirmationPolicy({
    agentId: "main",
    voiceSessionId,
    runId,
    toolName: "message",
    toolParams,
    isConfirmable: () => true,
    now,
  });
  if (challenge.allowed) {
    throw new Error("expected voice confirmation challenge");
  }
  const confirmationId = challenge.reason.match(/VOICE_CONFIRMATION_REQUIRED:([^\s]+)/)?.[1];
  if (!confirmationId) {
    throw new Error("missing voice confirmation id");
  }
  noteClientVoiceConfirmationUtterance({
    agentId: "main",
    voiceSessionId,
    text: "yes",
    timestamp: now + 1,
  });
  const grant = authorizeClientVoiceConfirmation({
    agentId: "main",
    voiceSessionId,
    confirmationId,
    now: now + 2,
  });
  bindAuthorizedClientVoiceConfirmation({ grant, runId });
}

describe("before_tool_call hook integration", () => {
  let beforeToolCallHook: BeforeToolCallHandlerMock;

  beforeEach(() => {
    resetGlobalHookRunner();
    resetDiagnosticSessionStateForTest();
    resetAdjustedParamsByToolCallIdForTests();
    resetDiagnosticEventsForTest();
    beforeToolCallHook = installBeforeToolCallHook();
  });

  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    resetClientVoiceConfirmationStateForTest();
    vi.restoreAllMocks();
  });

  it("executes tool normally when no hook is registered", async () => {
    beforeToolCallHook = installBeforeToolCallHook({ enabled: false });
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const tool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "Read", execute }), {
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
    expect(consumeTrackedToolExecutionStarted("call-1")).toBeUndefined();
  });

  it("records structured replay trust only for concrete core-owned tools", async () => {
    beforeToolCallHook = installBeforeToolCallHook({ enabled: false });
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const coreTool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "search", execute }), {
      runId: "run-core",
    });
    const pluginSource = asAgentTool({ name: "search", execute });
    setPluginToolMeta(pluginSource, { pluginId: "example", optional: false });
    const pluginTool = wrapToolWithBeforeToolCallHook(pluginSource, {
      runId: "run-plugin",
    });

    const [coreDefinition] = toToolDefinitions([coreTool], { runId: "run-core" });
    const [pluginDefinition] = toToolDefinitions([pluginTool], { runId: "run-plugin" });
    const extensionContext = {} as ExtensionContext;
    await coreDefinition?.execute(
      "call-core",
      { query: "core" },
      undefined,
      undefined,
      extensionContext,
    );
    await pluginDefinition?.execute(
      "call-plugin",
      { query: "plugin" },
      undefined,
      undefined,
      extensionContext,
    );

    expect(
      beforeToolCallTesting.structuredReplaySafeToolCallIds.has(
        beforeToolCallTesting.buildAdjustedParamsKey({
          runId: "run-core",
          toolCallId: "call-core",
        }),
      ),
    ).toBe(true);
    expect(
      beforeToolCallTesting.structuredReplaySafeToolCallIds.has(
        beforeToolCallTesting.buildAdjustedParamsKey({
          runId: "run-plugin",
          toolCallId: "call-plugin",
        }),
      ),
    ).toBe(false);
  });

  it("allows hook to modify parameters", async () => {
    beforeToolCallHook = installBeforeToolCallHook({
      runBeforeToolCallImpl: async () => ({ params: { mode: "safe" } }),
    });
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const tool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "exec", execute }));
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
    const tool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "exec", execute }));
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
    expect(consumeTrackedToolExecutionStarted("call-3")).toBeUndefined();
  });

  it("does not enter the tool body when a slow hook settles after cancellation", async () => {
    let releaseHook: () => void = () => {};
    const hookGate = new Promise<void>((resolve) => {
      releaseHook = resolve;
    });
    beforeToolCallHook = installBeforeToolCallHook({
      runBeforeToolCallImpl: async () => {
        await hookGate;
        return { params: { mode: "late" } };
      },
    });
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const controller = new AbortController();
    const tool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "exec", execute }));
    const result = tool.execute("call-late-abort", { cmd: "pwd" }, controller.signal);
    await vi.waitFor(() => expect(beforeToolCallHook).toHaveBeenCalledOnce());
    expect(consumeTrackedToolExecutionStarted("call-late-abort")).toBe(false);

    controller.abort(new Error("tool timed out"));
    releaseHook();

    await expect(result).rejects.toThrow("tool timed out");
    expect(execute).not.toHaveBeenCalled();
    expect(consumeTrackedToolExecutionStarted("call-late-abort")).toBeUndefined();
    expect(consumePreExecutionBlockedToolCall("call-late-abort")).toBe(true);
  });

  it("does not execute lower-priority hooks after block=true", async () => {
    const high = vi.fn().mockResolvedValue({ block: true, blockReason: "blocked-high" });
    const low = vi.fn().mockResolvedValue({ params: { shouldNotApply: true } });
    installBeforeToolCallHooks([
      { pluginId: "high", priority: 100, handler: high },
      { pluginId: "low", priority: 0, handler: low },
    ]);

    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const tool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "exec", execute }));
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
    const tool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "read", execute }));
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
    const tool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "ReAd", execute }), {
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
    const toolA = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "Read", execute }), {
      runId: "run-a",
    });
    const toolB = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "Read", execute }), {
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
    const baseTool = asAgentTool({
      name: "web_fetch",
      execute,
      description: "fetch",
      parameters: {},
    });

    const wrapped = wrapToolWithBeforeToolCallHook(baseTool, {
      agentId: "main",
      sessionKey: "main",
    });
    const def = expectDefined(toToolDefinitions([wrapped])[0], "wrapped web-fetch definition");
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

  it("preserves private execution semantics through both session tool adapters", async () => {
    const runId = "run-private-preparer-adapter";
    const source = wrapToolWithBeforeToolCallHook(
      asAgentTool({
        name: "search",
        execute: vi.fn().mockResolvedValue({ answer: 42 }),
      }),
      { runId },
    );
    const definition = expectDefined(
      toToolDefinitions([source], { runId })[0],
      "wrapped search tool definition",
    );
    const hydrated = wrapToolDefinition(definition);
    const preparer = expectDefined(
      getInternalToolExecutionPreparer(hydrated),
      "adapted private execution preparer",
    );
    const prepared = await preparer({
      toolCallId: "call-private-preparer-adapter",
      args: { query: "answer" },
    });
    expect(prepared.kind).toBe("ready");
    if (prepared.kind !== "ready") {
      return;
    }
    const result = await prepared.execute();
    prepared.dispose();

    expect(result.details).toEqual({ answer: 42 });
    expect(
      beforeToolCallTesting.structuredReplaySafeToolCallIds.has(
        beforeToolCallTesting.buildAdjustedParamsKey({
          runId,
          toolCallId: "call-private-preparer-adapter",
        }),
      ),
    ).toBe(true);
  });

  it("preserves adapter error and abort handling for private execution", async () => {
    const failure = new Error("private execution failed");
    const failedSource = wrapToolWithBeforeToolCallHook(
      asAgentTool({ name: "read", execute: vi.fn().mockRejectedValue(failure) }),
    );
    const failedTool = wrapToolDefinition(
      expectDefined(toToolDefinitions([failedSource])[0], "failed private tool definition"),
    );
    const failedPreparer = expectDefined(
      getInternalToolExecutionPreparer(failedTool),
      "failed-tool private execution preparer",
    );
    const failedPrepared = await failedPreparer({ toolCallId: "call-failed", args: {} });
    expect(failedPrepared.kind).toBe("ready");
    if (failedPrepared.kind !== "ready") {
      return;
    }
    await expect(failedPrepared.execute()).resolves.toMatchObject({
      details: { status: "error", error: failure.message },
    });
    failedPrepared.dispose();

    const controller = new AbortController();
    const abortReason = new Error("private execution aborted");
    const abortedSource = wrapToolWithBeforeToolCallHook(
      asAgentTool({
        name: "read",
        execute: vi.fn(async (_id, _params, signal?: AbortSignal) => {
          signal?.throwIfAborted();
          return { content: [], details: { ok: true } };
        }),
      }),
    );
    const abortedTool = wrapToolDefinition(
      expectDefined(toToolDefinitions([abortedSource])[0], "aborted private tool definition"),
    );
    const abortedPreparer = expectDefined(
      getInternalToolExecutionPreparer(abortedTool),
      "aborted-tool private execution preparer",
    );
    const abortedPrepared = await abortedPreparer({
      toolCallId: "call-aborted",
      args: {},
      signal: controller.signal,
    });
    expect(abortedPrepared.kind).toBe("ready");
    if (abortedPrepared.kind !== "ready") {
      return;
    }
    const execution = abortedPrepared.execute();
    controller.abort(abortReason);
    await expect(execution).rejects.toBe(abortReason);
    abortedPrepared.dispose();
  });

  it("finalizes private policy outcomes before launch", async () => {
    beforeToolCallHook = installBeforeToolCallHook({
      runBeforeToolCallImpl: async () => ({ block: true, blockReason: "blocked by policy" }),
    });
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const source = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "read", execute }));
    const tool = wrapToolDefinition(
      expectDefined(toToolDefinitions([source])[0], "policy-blocked private tool definition"),
    );
    const preparer = expectDefined(
      getInternalToolExecutionPreparer(tool),
      "policy private execution preparer",
    );

    const prepared = await preparer({ toolCallId: "call-policy", args: {} });

    expect(prepared).toMatchObject({
      kind: "immediate",
      outcome: {
        kind: "result",
        isError: false,
        result: { details: { status: "blocked", reason: "blocked by policy" } },
      },
    });
    prepared.dispose();
    expect(execute).not.toHaveBeenCalled();
  });

  it("commits final rewritten args immediately before private implementation", async () => {
    beforeToolCallHook = installBeforeToolCallHook({
      runBeforeToolCallImpl: async () => ({ params: { value: "rewritten" } }),
    });
    const order: string[] = [];
    const execute = vi.fn(async () => {
      order.push("body");
      return { content: [], details: { ok: true } };
    });
    const source = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "read", execute }));
    const tool = wrapToolDefinition(
      expectDefined(toToolDefinitions([source])[0], "rewritten private tool definition"),
    );
    const preparer = expectDefined(
      getInternalToolExecutionPreparer(tool),
      "rewritten private execution preparer",
    );
    const prepared = await preparer({
      toolCallId: "call-rewritten",
      args: { value: "original" },
    });
    expect(prepared.kind).toBe("ready");
    if (prepared.kind !== "ready") {
      return;
    }
    const onImplementationStart = vi.fn(() => {
      order.push("commit");
      queueMicrotask(() => order.push("gap"));
    });

    await prepared.execute(onImplementationStart);
    prepared.dispose();

    expect(prepared.args).toEqual({ value: "rewritten" });
    expect(onImplementationStart).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(
      "call-rewritten",
      { value: "rewritten" },
      undefined,
      undefined,
    );
    expect(order).toEqual(["commit", "body", "gap"]);
  });

  it("does not consume a voice grant when private execution is disposed", async () => {
    const runId = "run-voice-private-dispose";
    const toolParams = { action: "send", to: "target-a", message: "approved body" };
    installVoiceRunBinding(runId);
    approveVoiceToolParams(runId, toolParams);
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const hookContext = { runId, agentId: "main", sessionKey: "agent:main:voice" };
    const source = wrapToolWithBeforeToolCallHook(
      asAgentTool({ name: "message", execute }),
      hookContext,
    );
    const tool = wrapToolDefinition(
      expectDefined(toToolDefinitions([source], hookContext)[0], "voice private tool definition"),
    );
    const preparer = expectDefined(
      getInternalToolExecutionPreparer(tool),
      "voice private execution preparer",
    );
    try {
      const prepared = await preparer({ toolCallId: "call-voice-disposed", args: toolParams });
      expect(prepared.kind).toBe("ready");
      prepared.dispose();
      prepared.dispose();
      await Promise.resolve();

      const first = await tool.execute("call-voice-retry", toolParams);
      const second = await tool.execute("call-voice-consumed", toolParams);

      expect(first.details).toEqual({ ok: true });
      expect(second.details).toMatchObject({
        status: "blocked",
        deniedReason: "client-voice-confirmation",
      });
      expect(execute).toHaveBeenCalledOnce();
      expect(consumeTrackedToolExecutionStarted("call-voice-disposed", runId)).toBeUndefined();
    } finally {
      resetClientVoiceConfirmationStateForTest();
      vi.restoreAllMocks();
    }
  });

  it.each(["adapter", "client"] as const)(
    "suppresses the %s body after awaited hook preflight",
    async (kind) => {
      let releaseHook!: () => void;
      let markHookStarted!: () => void;
      const hookStarted = new Promise<void>((resolve) => {
        markHookStarted = resolve;
      });
      const hookRelease = new Promise<void>((resolve) => {
        releaseHook = resolve;
      });
      beforeToolCallHook = installBeforeToolCallHook({
        runBeforeToolCallImpl: async () => {
          markHookStarted();
          await hookRelease;
          return undefined;
        },
      });
      const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
      const clientCall = vi.fn();
      const definition =
        kind === "adapter"
          ? expectDefined(
              toToolDefinitions([asAgentTool({ name: "read", execute })])[0],
              "unwrapped adapter definition",
            )
          : expectDefined(
              toClientToolDefinitions(
                [
                  {
                    type: "function",
                    function: {
                      name: "client_read",
                      description: "client read",
                      parameters: { type: "object", properties: {} },
                    },
                  },
                ],
                clientCall,
              )[0],
              "client adapter definition",
            );
      const preparer = expectDefined(
        getInternalToolExecutionPreparer(wrapToolDefinition(definition)),
        `${kind} private execution preparer`,
      );

      const preparing = preparer({ toolCallId: `${kind}-call`, args: {} });
      await hookStarted;
      releaseHook();
      const prepared = await preparing;
      expect(prepared.kind).toBe("ready");
      prepared.dispose();
      await Promise.resolve();

      expect(execute).not.toHaveBeenCalled();
      expect(clientCall).not.toHaveBeenCalled();
    },
  );

  it("finishes async reconciliation before exposing a wrapped call as ready", async () => {
    beforeToolCallHook = installBeforeToolCallHook({
      runBeforeToolCallImpl: async () => ({ params: { path: "/tmp/final" } }),
    });
    const runId = "run-reconcile-before-ready";
    const sessionKey = "agent:main:reconcile-before-ready";
    const state = getDiagnosticSessionState({ sessionKey, sessionId: "session-reconcile" });
    recordToolCall(
      state,
      "read",
      { path: "/tmp/original" },
      "reconcile-call",
      { enabled: true },
      { runId },
    );
    const execute = vi.fn().mockResolvedValue({ content: [], details: {} });
    const hookContext = {
      runId,
      sessionKey,
      sessionId: "session-reconcile",
      loopDetection: { enabled: true },
    };
    const source = wrapToolWithBeforeToolCallHook(
      asAgentTool({ name: "read", execute }),
      hookContext,
    );
    const tool = wrapToolDefinition(
      expectDefined(toToolDefinitions([source], hookContext)[0], "reconcile tool definition"),
    );
    const preparer = expectDefined(
      getInternalToolExecutionPreparer(tool),
      "reconcile private execution preparer",
    );

    const prepared = await preparer({
      toolCallId: "reconcile-call",
      args: { path: "/tmp/original" },
    });

    expect(prepared.kind).toBe("ready");
    expect(state.toolCallHistory?.at(-1)?.argsHash).toBe(
      hashToolCall("read", { path: "/tmp/final" }),
    );
    prepared.dispose();
    expect(execute).not.toHaveBeenCalled();
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
      [
        asAgentTool({
          name: "exec",
          execute: plainExecute,
          description: "Plain exec",
          parameters: {},
        }),
      ],
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
    const abortSignal = new AbortController().signal;
    const wrapped = wrapToolWithAbortSignal(
      wrapToolWithBeforeToolCallHook(execTool, {
        agentId: "main",
        sessionKey: "agent:main:main",
        sessionId: "session-main",
        runId: "run-main",
      }),
      abortSignal,
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
        abortSignal,
        toolCallId: "call-wrapped-code-mode-exec",
      },
    );
  });

  it("mirrors single-alias hook rewrites for code-mode exec aliases", async () => {
    beforeToolCallHook = installBeforeToolCallHook({
      runBeforeToolCallImpl: async () => ({ params: { command: "return 2;" } }),
    });
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const tool = markCodeModeControlTool(
      asAgentTool({
        name: CODE_MODE_EXEC_TOOL_NAME,
        execute,
        description: "exec",
        parameters: {},
      }),
    );
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
      const tool = markCodeModeControlTool(
        asAgentTool({
          name: CODE_MODE_EXEC_TOOL_NAME,
          execute,
          description: "exec",
          parameters: {},
        }),
      );
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
    const baseTool = asAgentTool({ name: "Bash", execute, description: "bash", parameters: {} });

    const abortController = new AbortController();
    const wrapped = wrapToolWithBeforeToolCallHook(baseTool, {
      agentId: "main",
      sessionKey: "main",
    });
    const withAbort = wrapToolWithAbortSignal(wrapped, abortController.signal);
    const def = expectDefined(toToolDefinitions([withAbort])[0], "abort-wrapped Bash definition");
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

  it("emits a tool-authored terminal presentation with the recorded outcome", async () => {
    const onToolOutcome = vi.fn();
    const sourceTool = setToolTerminalPresentation(
      asAgentTool({
        name: "web_fetch",
        description: "fetch",
        parameters: {},
        resultContentSource: "network",
        execute: vi.fn().mockResolvedValue({
          content: [],
          details: { status: 200 },
        }),
      }),
      (_params, result) => ({
        text: `Fetched with status ${(result.details as { status: number }).status}`,
      }),
    );
    const tool = expectDefined(
      wrapToolWithBeforeToolCallHook(
        normalizeToolParameters(sourceTool, { modelProvider: "openai" }),
        {
          sessionId: "session-terminal-presentation",
          onToolOutcome,
        },
      ),
      "wrapToolWithBeforeToolCallHook( normalizeToolParameters(sourceTool, {... test invariant",
    );
    await tool.execute("call-terminal-presentation", {
      url: "https://example.com",
    });

    expect(onToolOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "web_fetch",
        resultContentSource: "network",
        terminalPresentation: "Fetched with status 200",
      }),
    );
  });

  it("keeps the later model-ordered result when parallel tools finish out of order", async () => {
    type ToolResult = { content: []; details: { ok?: boolean; status?: number } };
    let resolvePresentation!: (result: ToolResult) => void;
    let resolvePlain!: (result: ToolResult) => void;
    const presentationExecution = new Promise<ToolResult>((resolve) => {
      resolvePresentation = resolve;
    });
    const plainExecution = new Promise<ToolResult>((resolve) => {
      resolvePlain = resolve;
    });
    let terminalPresentation: string | undefined;
    let latestOrdinal = -1;
    const onToolOutcome = vi.fn(
      (outcome: { toolCallOrdinal?: number; terminalPresentation?: string }) => {
        const ordinal = outcome.toolCallOrdinal ?? latestOrdinal + 1;
        if (ordinal >= latestOrdinal) {
          latestOrdinal = ordinal;
          terminalPresentation = outcome.terminalPresentation;
        }
      },
    );
    let nextToolOutcomeOrdinal = 0;
    const hookContext = {
      runId: "run-parallel-terminal-presentation",
      sessionId: "session-parallel-terminal-presentation",
      onToolOutcome,
      allocateToolOutcomeOrdinal: () => nextToolOutcomeOrdinal++,
    };
    const presentationTool = wrapToolWithBeforeToolCallHook(
      setToolTerminalPresentation(
        asAgentTool({
          name: "web_fetch",
          description: "fetch",
          parameters: {},
          execute: vi.fn(() => presentationExecution),
        }),
        () => ({ text: "Fetched with status 200" }),
      ),
      hookContext,
    );
    const plainTool = wrapToolWithBeforeToolCallHook(
      asAgentTool({
        name: "read_file",
        description: "read",
        parameters: {},
        execute: vi.fn(() => plainExecution),
      }),
      hookContext,
    );

    const presentationResultPromise = presentationTool.execute("call-presentation", {});
    const plainResultPromise = plainTool.execute("call-plain", {});

    resolvePlain({ content: [], details: { ok: true } });
    const plainResult = await plainResultPromise;
    finalizeToolTerminalPresentation({
      toolCallId: "call-plain",
      runId: hookContext.runId,
      result: plainResult,
      isError: false,
    });
    expect(terminalPresentation).toBeUndefined();

    resolvePresentation({ content: [], details: { status: 200 } });
    const presentationResult = await presentationResultPromise;
    finalizeToolTerminalPresentation({
      toolCallId: "call-presentation",
      runId: hookContext.runId,
      result: presentationResult,
      isError: false,
    });

    expect(terminalPresentation).toBeUndefined();
    expect(onToolOutcome.mock.calls.map(([outcome]) => outcome.toolCallOrdinal)).toEqual([
      1, 1, 0, 0,
    ]);
    expect(onToolOutcome).toHaveBeenLastCalledWith(
      expect.objectContaining({
        toolCallOrdinal: 0,
        terminalPresentation: "Fetched with status 200",
      }),
    );
  });

  it("passes hook context for unwrapped tool definitions", async () => {
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const baseTool = asAgentTool({ name: "exec", execute, description: "exec", parameters: {} });
    const def = expectDefined(
      toToolDefinitions([baseTool], {
        agentId: "code-agent",
        sessionKey: "agent:code-agent:main",
        sessionId: "session-code",
        runId: "run-code",
        channelId: "channel-code",
      })[0],
      "unwrapped exec definition",
    );
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
    const baseTool = asAgentTool({ name: "Bash", execute, description: "bash", parameters: {} });
    const wrapped = wrapToolWithBeforeToolCallHook(baseTool, {
      agentId: "main",
      sessionKey: "main",
    });
    const withAbort = wrapToolWithAbortSignal(wrapped, new AbortController().signal);

    expect(isToolWrappedWithBeforeToolCallHook(withAbort)).toBe(true);
  });
});

describe("before_tool_call adapter and client tool integration", () => {
  function installAbortBlockingHook() {
    let markStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let observedAbort = false;
    installBeforeToolCallHook({
      runBeforeToolCallImpl: async (_event, ctx) => {
        const signal = (ctx as { abortSignal?: AbortSignal }).abortSignal;
        markStarted();
        if (signal) {
          await new Promise<void>((resolve) => {
            if (signal.aborted) {
              observedAbort = true;
              resolve();
              return;
            }
            signal.addEventListener(
              "abort",
              () => {
                observedAbort = true;
                resolve();
              },
              { once: true },
            );
          });
        }
        return { block: true, blockReason: "cancelled by owning tool call" };
      },
    });
    return {
      started,
      didObserveAbort: () => observedAbort,
    };
  }

  beforeEach(() => {
    resetGlobalHookRunner();
    resetDiagnosticSessionStateForTest();
    resetDiagnosticEventsForTest();
    installBeforeToolCallHook();
  });

  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    resetClientVoiceConfirmationStateForTest();
    vi.restoreAllMocks();
  });

  it.each(["wrapped", "adapter"] as const)(
    "cancels before-tool hook work through the %s path",
    async (pathKind) => {
      const controller = new AbortController();
      const hook = installAbortBlockingHook();
      const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
      const sourceTool = asAgentTool({ name: "read", execute });
      const tool = pathKind === "wrapped" ? wrapToolWithBeforeToolCallHook(sourceTool) : sourceTool;
      const definition = expectDefined(toToolDefinitions([tool])[0], `${pathKind} tool definition`);

      const execution = definition.execute(
        `call-signal-${pathKind}`,
        { path: "/tmp/input" },
        controller.signal,
        undefined,
        {} as ExtensionContext,
      );
      await hook.started;
      controller.abort(new Error("cancel test"));
      await execution;

      expect(hook.didObserveAbort()).toBe(true);
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it("cancels client-tool hook work and releases its reservation", async () => {
    const controller = new AbortController();
    const hook = installAbortBlockingHook();
    const recorder = {
      reserve: vi.fn(),
      complete: vi.fn(),
      discard: vi.fn(),
    };
    const tool = expectDefined(
      toClientToolDefinitions(
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
        recorder,
      )[0],
      "client tool definition",
    );

    const execution = tool.execute(
      "client-call-signal",
      {},
      controller.signal,
      undefined,
      {} as ExtensionContext,
    );
    await hook.started;
    controller.abort(new Error("cancel test"));
    await execution;

    expect(hook.didObserveAbort()).toBe(true);
    expect(recorder.reserve).toHaveBeenCalledWith("client-call-signal", "client_tool");
    expect(recorder.discard).toHaveBeenCalledWith("client-call-signal", "client_tool");
    expect(recorder.complete).not.toHaveBeenCalled();
  });

  it("passes modified params to client tool callbacks", async () => {
    installBeforeToolCallHook({
      runBeforeToolCallImpl: async () => ({ params: { extra: true } }),
    });
    const onClientToolCall = vi.fn();
    const clientTools = toClientToolDefinitions(
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
    const tool = expectDefined(clientTools[0], "client tool definition");
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
      await replaceSessionEntry({ sessionKey: "agent:main:client", storePath }, {
        sessionId: "session-client",
        updatedAt: Date.now(),
      } as SessionEntry);
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

      const clientTools = toClientToolDefinitions(
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
      const tool = expectDefined(clientTools[0], "client tool definition");
      const extensionContext = {} as Parameters<typeof tool.execute>[4];
      await tool.execute("client-call-policy", {}, undefined, undefined, extensionContext);

      expect(seen).toEqual([{ gate: "client" }]);
    } finally {
      setActivePluginRegistry(createEmptyPluginRegistry());
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it.each(["wrapped", "adapter"] as const)(
    "executes unchanged approved voice params once through the %s path",
    async (pathKind) => {
      const runId = `run-voice-unchanged-${pathKind}`;
      const toolParams = { action: "send", to: "target-a", message: "approved body" };
      installVoiceRunBinding(runId);
      approveVoiceToolParams(runId, toolParams);
      const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
      const preparedState = new WeakMap<object, string>();
      const prepareBeforeToolCallParams = vi.fn((params: unknown) => {
        const prepared = { ...(params as Record<string, unknown>) };
        preparedState.set(prepared, "prepared");
        return prepared;
      });
      const finalizeBeforeToolCallParams = vi.fn(
        (finalParams: unknown, preparedParams: unknown) => {
          expect(preparedState.get(preparedParams as object)).toBe("prepared");
          return finalParams;
        },
      );
      const sourceTool = {
        name: "message",
        execute,
        prepareBeforeToolCallParams,
        finalizeBeforeToolCallParams,
      } as unknown as AnyAgentTool;
      const hookContext = { runId, agentId: "main", sessionKey: "agent:main:voice" };
      const tool =
        pathKind === "wrapped"
          ? wrapToolWithBeforeToolCallHook(sourceTool, hookContext)
          : sourceTool;
      const definition = expectDefined(
        toToolDefinitions([tool], hookContext)[0],
        `${pathKind} voice tool definition`,
      );
      const extensionContext = {} as ExtensionContext;

      const first = await definition.execute(
        `call-voice-unchanged-${pathKind}-1`,
        toolParams,
        undefined,
        undefined,
        extensionContext,
      );
      const second = await definition.execute(
        `call-voice-unchanged-${pathKind}-2`,
        toolParams,
        undefined,
        undefined,
        extensionContext,
      );

      expect(first.details).toEqual({ ok: true });
      expect(second.details).toMatchObject({
        status: "blocked",
        deniedReason: "client-voice-confirmation",
      });
      expect(execute).toHaveBeenCalledOnce();
      expect(prepareBeforeToolCallParams).toHaveBeenCalledTimes(2);
      expect(finalizeBeforeToolCallParams).toHaveBeenCalledOnce();
      expect(execute).toHaveBeenCalledWith(
        `call-voice-unchanged-${pathKind}-1`,
        toolParams,
        undefined,
        undefined,
      );
    },
  );

  it.each(["wrapped", "adapter"] as const)(
    "blocks approved voice params rewritten to another action through the %s path",
    async (pathKind) => {
      installBeforeToolCallHook({
        runBeforeToolCallImpl: async () => ({
          params: { action: "send", to: "target-b", message: "rewritten body" },
        }),
      });
      const runId = `run-voice-rewritten-${pathKind}`;
      const approvedParams = { action: "send", to: "target-a", message: "approved body" };
      installVoiceRunBinding(runId);
      approveVoiceToolParams(runId, approvedParams);
      const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
      const sourceTool = asAgentTool({ name: "message", execute });
      const hookContext = { runId, agentId: "main", sessionKey: "agent:main:voice" };
      const tool =
        pathKind === "wrapped"
          ? wrapToolWithBeforeToolCallHook(sourceTool, hookContext)
          : sourceTool;
      const definition = expectDefined(
        toToolDefinitions([tool], hookContext)[0],
        `${pathKind} rewritten voice tool definition`,
      );
      const emitted: DiagnosticEventPayload[] = [];
      const stop = onInternalDiagnosticEvent((event) => emitted.push(event));

      try {
        const result = await definition.execute(
          `call-voice-rewritten-${pathKind}`,
          approvedParams,
          undefined,
          undefined,
          {} as ExtensionContext,
        );
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });

        expect(result.details).toMatchObject({
          status: "blocked",
          deniedReason: "client-voice-confirmation",
        });
        expect(execute).not.toHaveBeenCalled();
        if (pathKind === "wrapped") {
          expect(emitted.find((event) => event.type === "security.event")).toMatchObject({
            type: "security.event",
            reason: "client-voice-confirmation",
            policy: {
              id: "talk-client-voice-confirmation",
              reason: "client-voice-confirmation",
            },
            control: {
              id: "talk-client-voice-confirmation",
              family: "approval",
            },
          });
        }
      } finally {
        stop();
      }
    },
  );

  it.each(["wrapped", "adapter"] as const)(
    "blocks a %s path finalizer that changes approved voice params",
    async (pathKind) => {
      const runId = `run-voice-finalizer-${pathKind}`;
      const approvedParams = { action: "send", to: "target-a", message: "approved body" };
      installVoiceRunBinding(runId);
      approveVoiceToolParams(runId, approvedParams);
      const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
      const preparedState = new WeakMap<object, string>();
      const sourceTool = {
        name: "message",
        execute,
        prepareBeforeToolCallParams(params: unknown) {
          const prepared = { ...(params as Record<string, unknown>) };
          preparedState.set(prepared, "prepared");
          return prepared;
        },
        finalizeBeforeToolCallParams(finalParams: unknown, preparedParams: unknown) {
          expect(preparedState.get(preparedParams as object)).toBe("prepared");
          return { ...(finalParams as Record<string, unknown>), to: "target-b" };
        },
      } as unknown as AnyAgentTool;
      const hookContext = { runId, agentId: "main", sessionKey: "agent:main:voice" };
      const tool =
        pathKind === "wrapped"
          ? wrapToolWithBeforeToolCallHook(sourceTool, hookContext)
          : sourceTool;
      const definition = expectDefined(
        toToolDefinitions([tool], hookContext)[0],
        `${pathKind} finalized voice tool definition`,
      );

      const result = await definition.execute(
        `call-voice-finalizer-${pathKind}`,
        approvedParams,
        undefined,
        undefined,
        {} as ExtensionContext,
      );

      expect(result.details).toMatchObject({
        status: "blocked",
        deniedReason: "client-voice-confirmation",
      });
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it.each(["wrapped", "adapter"] as const)(
    "requires voice confirmation when the %s path rewrites a read into a mutation",
    async (pathKind) => {
      const rewrittenParams = { action: "send", to: "target-b", message: "new mutation" };
      if (pathKind === "wrapped") {
        installBeforeToolCallHook({
          runBeforeToolCallImpl: async () => ({ params: rewrittenParams }),
        });
      } else {
        resetGlobalHookRunner();
        const registry = createEmptyPluginRegistry();
        registry.trustedToolPolicies = [
          {
            pluginId: "trusted-voice-test",
            pluginName: "Trusted Voice Test",
            source: "test",
            policy: {
              id: "rewrite-read-to-mutation",
              description: "exercise final voice confirmation after a trusted rewrite",
              evaluate: () => ({ params: rewrittenParams }),
            },
          },
        ];
        setActivePluginRegistry(registry);
        initializeGlobalHookRunner(registry);
      }
      const runId = `run-voice-new-mutation-${pathKind}`;
      installVoiceRunBinding(runId);
      const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
      const sourceTool = asAgentTool({ name: "message", execute });
      const hookContext = { runId, agentId: "main", sessionKey: "agent:main:voice" };
      const tool =
        pathKind === "wrapped"
          ? wrapToolWithBeforeToolCallHook(sourceTool, hookContext)
          : sourceTool;
      const definition = expectDefined(
        toToolDefinitions([tool], hookContext)[0],
        `${pathKind} new voice mutation tool definition`,
      );

      const result = await definition.execute(
        `call-voice-new-mutation-${pathKind}`,
        { action: "search", query: "status" },
        undefined,
        undefined,
        {} as ExtensionContext,
      );

      expect(result.details).toMatchObject({
        status: "blocked",
        deniedReason: "client-voice-confirmation",
      });
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it("consumes an approved voice grant before delegating a client-hosted tool", async () => {
    const runId = "run-voice-client-tool";
    const toolParams = { action: "send", to: "target-a", message: "approved body" };
    installVoiceRunBinding(runId);
    approveVoiceToolParams(runId, toolParams);
    const onClientToolCall = vi.fn();
    const definition = expectDefined(
      toClientToolDefinitions(
        [
          {
            type: "function",
            function: {
              name: "message",
              description: "client-hosted message tool",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
        onClientToolCall,
        { runId, agentId: "main", sessionKey: "agent:main:voice" },
      )[0],
      "client-hosted voice tool definition",
    );

    const first = await definition.execute(
      "call-voice-client-1",
      toolParams,
      undefined,
      undefined,
      {} as ExtensionContext,
    );
    const second = await definition.execute(
      "call-voice-client-2",
      toolParams,
      undefined,
      undefined,
      {} as ExtensionContext,
    );

    expect(first.details).toMatchObject({ status: "pending" });
    expect(second.details).toMatchObject({
      status: "blocked",
      deniedReason: "client-voice-confirmation",
    });
    expect(onClientToolCall).toHaveBeenCalledOnce();
    expect(onClientToolCall).toHaveBeenCalledWith("message", toolParams);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
