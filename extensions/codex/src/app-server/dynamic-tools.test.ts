// Codex tests cover dynamic tools plugin behavior.
import { createHash } from "node:crypto";
import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import type { AnyAgentTool } from "openclaw/plugin-sdk/agent-harness";
import {
  HEARTBEAT_RESPONSE_TOOL_NAME,
  embeddedAgentLog,
  wrapToolWithBeforeToolCallHook,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { createTerminalPresentationContractTool } from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import {
  onInternalDiagnosticEvent,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/hook-runtime";
import {
  createEmptyPluginRegistry,
  createMockPluginRegistry,
  createTestRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CODEX_OPENCLAW_DYNAMIC_TOOL_NAMESPACE,
  createCodexDynamicToolBridge,
} from "./dynamic-tools.js";
import {
  CODEX_OPENCLAW_DIRECT_DYNAMIC_TOOL_NAMESPACE,
  type CodexDynamicToolFunctionSpec,
  type CodexDynamicToolSpec,
  type JsonValue,
} from "./protocol.js";

const COMPUTER_FRAME_IMAGE =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
const REPLACEMENT_FRAME_IMAGE =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=";

function frameImageIdentity(data: string, mimeType = "image/png") {
  return createHash("sha256")
    .update(JSON.stringify([mimeType, data]))
    .digest("hex");
}

function createTool(overrides: Partial<AnyAgentTool>): AnyAgentTool {
  return {
    name: "tts",
    description: "Convert text to speech.",
    parameters: { type: "object", properties: {} },
    execute: vi.fn(),
    ...overrides,
  } as unknown as AnyAgentTool;
}

function mediaResult(mediaUrl: string, audioAsVoice?: boolean): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text: "Generated media reply." }],
    details: {
      media: {
        mediaUrl,
        ...(audioAsVoice === true ? { audioAsVoice: true } : {}),
      },
    },
  };
}

function textToolResult(text: string, details: unknown = {}): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text }],
    details,
  };
}

function createBridgeWithToolResult(
  toolName: string,
  toolResult: AgentToolResult<unknown>,
  hookContext?: Parameters<typeof createCodexDynamicToolBridge>[0]["hookContext"],
) {
  return createCodexDynamicToolBridge({
    tools: [
      createTool({
        name: toolName,
        execute: vi.fn(async () => toolResult),
      }),
    ],
    signal: new AbortController().signal,
    hookContext,
  });
}

function expectInputText(text: string) {
  return {
    success: true,
    contentItems: [{ type: "inputText", text }],
  };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error(`expected ${label}`);
  }
  return value as Record<string, unknown>;
}
function callArg(
  mock: { mock: { calls: Array<Array<unknown>> } },
  callIndex: number,
  argIndex: number,
  label: string,
) {
  const call = mock.mock.calls.at(callIndex);
  if (!call) {
    throw new Error(`Expected ${label}`);
  }
  return call[argIndex];
}

function expectDynamicSpec(
  spec: unknown,
  fields: { name: string; namespace?: string; deferLoading?: boolean },
) {
  const record = requireRecord(spec, `${fields.name} spec`);
  expect(record.name).toBe(fields.name);
  if (fields.namespace !== undefined) {
    expect(record.namespace).toBe(fields.namespace);
  }
  if (fields.deferLoading !== undefined) {
    expect(record.deferLoading).toBe(fields.deferLoading);
  }
}

function flattenSpecsWithNamespace(
  specs: readonly CodexDynamicToolSpec[],
): Array<CodexDynamicToolFunctionSpec & { namespace?: string }> {
  return specs.flatMap((spec) =>
    spec.type === "namespace"
      ? spec.tools.map((tool) => ({ ...tool, namespace: spec.name }))
      : [spec],
  );
}

function specNames(specs: readonly CodexDynamicToolSpec[]): string[] {
  return flattenSpecsWithNamespace(specs).map((tool) => tool.name);
}

function expectNoNamespace(spec: unknown) {
  const record = requireRecord(spec, "tool spec");
  expect(record).not.toHaveProperty("namespace");
  expect(record).not.toHaveProperty("deferLoading");
}

function expectContextFields(context: unknown, fields: Record<string, unknown>) {
  const record = requireRecord(context, "hook context");
  for (const [key, value] of Object.entries(fields)) {
    expect(record[key]).toEqual(value);
  }
}

function expectToolResult(value: unknown, expected: AgentToolResult<unknown>) {
  const result = requireRecord(value, "tool result");
  expect(result.content).toEqual(expected.content);
  expect(result.details).toEqual(expected.details);
}

function expectExecuteCall(
  execute: { mock: { calls: Array<Array<unknown>> } },
  expected: { callId: string; args: Record<string, unknown> },
) {
  expect(callArg(execute, 0, 0, "execute call id")).toBe(expected.callId);
  expect(callArg(execute, 0, 1, "execute args")).toEqual(expected.args);
  expect(callArg(execute, 0, 2, "execute signal")).toBeInstanceOf(AbortSignal);
  expect(callArg(execute, 0, 3, "execute extra")).toBeUndefined();
}

async function handleMessageToolCall(
  bridge: ReturnType<typeof createCodexDynamicToolBridge>,
  arguments_: JsonValue,
) {
  return await bridge.handleToolCall({
    threadId: "thread-1",
    turnId: "turn-1",
    callId: "call-1",
    namespace: null,
    tool: "message",
    arguments: arguments_,
  });
}

afterEach(() => {
  resetGlobalHookRunner();
  setActivePluginRegistry(createEmptyPluginRegistry());
});

describe("createCodexDynamicToolBridge", () => {
  it("keeps OpenClaw control-path tools direct while deferring broad tools", () => {
    const bridge = createCodexDynamicToolBridge({
      tools: [
        createTool({ name: "web_search" }),
        createTool({ name: "message" }),
        createTool({ name: HEARTBEAT_RESPONSE_TOOL_NAME }),
        createTool({ name: "agents_list" }),
        createTool({ name: "sessions_spawn" }),
        createTool({ name: "sessions_yield" }),
      ],
      signal: new AbortController().signal,
    });

    const specs = flattenSpecsWithNamespace(bridge.specs);
    const webSearch = specs.find((tool) => tool.name === "web_search");
    const message = specs.find((tool) => tool.name === "message");
    const heartbeat = specs.find((tool) => tool.name === HEARTBEAT_RESPONSE_TOOL_NAME);
    const agentsList = specs.find((tool) => tool.name === "agents_list");
    const sessionsSpawn = specs.find((tool) => tool.name === "sessions_spawn");
    const sessionsYield = specs.find((tool) => tool.name === "sessions_yield");

    expectDynamicSpec(webSearch, {
      name: "web_search",
      namespace: CODEX_OPENCLAW_DYNAMIC_TOOL_NAMESPACE,
      deferLoading: true,
    });
    expectDynamicSpec(message, {
      name: "message",
      namespace: CODEX_OPENCLAW_DYNAMIC_TOOL_NAMESPACE,
      deferLoading: true,
    });
    expectDynamicSpec(heartbeat, {
      name: HEARTBEAT_RESPONSE_TOOL_NAME,
      namespace: CODEX_OPENCLAW_DYNAMIC_TOOL_NAMESPACE,
      deferLoading: true,
    });
    expectNoNamespace(agentsList);
    expectNoNamespace(sessionsSpawn);
    expectNoNamespace(sessionsYield);
  });

  it("keeps configured direct tools in the initial Codex tool context", () => {
    const bridge = createCodexDynamicToolBridge({
      tools: [createTool({ name: "message" }), createTool({ name: "web_search" })],
      signal: new AbortController().signal,
      directToolNames: ["message"],
    });

    const specs = flattenSpecsWithNamespace(bridge.specs);
    expect(bridge.specs).toHaveLength(2);
    expectDynamicSpec(
      specs.find((tool) => tool.name === "message"),
      { name: "message" },
    );
    expectDynamicSpec(
      specs.find((tool) => tool.name === "web_search"),
      {
        name: "web_search",
        namespace: CODEX_OPENCLAW_DYNAMIC_TOOL_NAMESPACE,
        deferLoading: true,
      },
    );
    expectNoNamespace(specs.find((tool) => tool.name === "message"));
  });

  it("isolates direct-only tools in Codex's model-only namespace", () => {
    const bridge = createCodexDynamicToolBridge({
      tools: [
        createTool({ name: "computer", catalogMode: "direct-only" }),
        createTool({ name: "message" }),
      ],
      signal: new AbortController().signal,
      directToolNames: ["computer", "message"],
    });

    const specs = flattenSpecsWithNamespace(bridge.specs);
    expectDynamicSpec(
      specs.find((tool) => tool.name === "computer"),
      {
        name: "computer",
        namespace: CODEX_OPENCLAW_DIRECT_DYNAMIC_TOOL_NAMESPACE,
      },
    );
    expect(specs.find((tool) => tool.name === "computer")).not.toHaveProperty("deferLoading");
    expectNoNamespace(specs.find((tool) => tool.name === "message"));
  });

  it("can register a durable tool schema while denying execution for the current turn", async () => {
    const heartbeatExecute = vi.fn(async () => textToolResult("heartbeat recorded"));
    const onAgentToolResult = vi.fn();
    const onToolOutcome = vi.fn();
    const bridge = createCodexDynamicToolBridge({
      tools: [createTool({ name: "message" })],
      registeredTools: [
        createTool({ name: "message" }),
        createTool({ name: HEARTBEAT_RESPONSE_TOOL_NAME, execute: heartbeatExecute }),
      ],
      signal: new AbortController().signal,
      hookContext: { runId: "run-unavailable", onToolOutcome },
    });

    expect(specNames(bridge.availableSpecs)).toEqual(["message"]);
    expect(specNames(bridge.specs)).toEqual(["message", HEARTBEAT_RESPONSE_TOOL_NAME]);

    const result = await bridge.handleToolCall(
      {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        namespace: null,
        tool: HEARTBEAT_RESPONSE_TOOL_NAME,
        arguments: {},
      },
      { onAgentToolResult },
    );

    expect(result).toEqual({
      success: false,
      contentItems: [
        {
          type: "inputText",
          text: `OpenClaw tool is not available for this turn: ${HEARTBEAT_RESPONSE_TOOL_NAME}`,
        },
      ],
    });
    expect(heartbeatExecute).not.toHaveBeenCalled();
    expect(onAgentToolResult).toHaveBeenCalledWith({
      toolName: HEARTBEAT_RESPONSE_TOOL_NAME,
      result: {
        content: [
          {
            type: "text",
            text: `OpenClaw tool is not available for this turn: ${HEARTBEAT_RESPONSE_TOOL_NAME}`,
          },
        ],
        details: {
          status: "failed",
          error: `OpenClaw tool is not available for this turn: ${HEARTBEAT_RESPONSE_TOOL_NAME}`,
        },
      },
      isError: true,
    });
    expect(onToolOutcome).toHaveBeenLastCalledWith({
      toolName: HEARTBEAT_RESPONSE_TOOL_NAME,
      argsHash: "",
      resultHash: "",
      terminalPresentation: undefined,
      presentationOnly: true,
    });
  });

  it("treats an accepted child session spawn result as a successful dynamic tool call", async () => {
    // An accepted sessions_spawn launch carries details.status "accepted" with a
    // runId + childSessionKey. The launch succeeded (the child session was
    // accepted), so Codex must see a successful tool call, not an error.
    // Regression for #96833: "accepted" was missing from the non-error status
    // allowlist, so the launch was classified as an error and persisted with
    // isError: true (and reported to Codex as success: false).
    const onAgentToolResult = vi.fn();
    const bridge = createBridgeWithToolResult(
      "sessions_spawn",
      textToolResult("Accepted: launching child session to scan logs.", {
        status: "accepted",
        runId: "run_5f3a9c",
        childSessionKey: "child-7b21",
        mode: "run",
      }),
    );

    const result = await bridge.handleToolCall(
      {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-accepted",
        namespace: null,
        tool: "sessions_spawn",
        arguments: { task: "scan logs" },
      },
      { onAgentToolResult },
    );

    // success: true proves the accepted launch is not classified as an error;
    // the content assertion proves the tool actually executed (not a denial path).
    expect(result.success).toBe(true);
    expect(result.contentItems).toEqual([
      { type: "inputText", text: "Accepted: launching child session to scan logs." },
    ]);
    expect(onAgentToolResult).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "sessions_spawn", isError: false }),
    );
  });

  it("still reports a forbidden sessions_spawn result as a failed dynamic tool call", async () => {
    // Deny symmetry: a genuinely rejected spawn (status "forbidden") must stay an
    // error so the accepted-status allowlist entry does not over-correct.
    const bridge = createBridgeWithToolResult(
      "sessions_spawn",
      textToolResult("Forbidden: spawn limit reached.", { status: "forbidden" }),
    );

    const result = await bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-forbidden",
      namespace: null,
      tool: "sessions_spawn",
      arguments: { task: "deploy" },
    });

    expect(result.success).toBe(false);
  });

  it("treats accepted goal tool statuses (created / updated) as successful dynamic tool calls", async () => {
    // Same classifier-completeness class as the accepted spawn fix: create_goal /
    // update_goal return details.status "created" / "updated", reach codex agents
    // through the dynamic-tool bridge, and must not be classified as errors (#96833).
    const createdBridge = createBridgeWithToolResult(
      "create_goal",
      textToolResult("Goal created.", { status: "created" }),
    );
    const createdResult = await createdBridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-created",
      namespace: null,
      tool: "create_goal",
      arguments: { text: "ship the fix" },
    });
    expect(createdResult.success).toBe(true);

    const updatedBridge = createBridgeWithToolResult(
      "update_goal",
      textToolResult("Goal updated.", { status: "updated" }),
    );
    const updatedResult = await updatedBridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-updated",
      namespace: null,
      tool: "update_goal",
      arguments: { status: "completed" },
    });
    expect(updatedResult.success).toBe(true);
  });

  it("treats get_goal read statuses (found / missing) as successful dynamic tool calls", async () => {
    const onFoundResult = vi.fn();
    const foundBridge = createBridgeWithToolResult(
      "get_goal",
      textToolResult('{\n  "status": "found"\n}', {
        status: "found",
        goal: { objective: "ship the fix", status: "active" },
      }),
    );
    const foundResult = await foundBridge.handleToolCall(
      {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-found",
        namespace: null,
        tool: "get_goal",
        arguments: {},
      },
      { onAgentToolResult: onFoundResult },
    );
    expect(foundResult.success).toBe(true);
    expect(onFoundResult).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "get_goal", isError: false }),
    );

    const onMissingResult = vi.fn();
    const missingBridge = createBridgeWithToolResult(
      "get_goal",
      textToolResult('{\n  "status": "missing"\n}', { status: "missing" }),
    );
    const missingResult = await missingBridge.handleToolCall(
      {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-missing",
        namespace: null,
        tool: "get_goal",
        arguments: {},
      },
      { onAgentToolResult: onMissingResult },
    );
    expect(missingResult.success).toBe(true);
    expect(onMissingResult).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "get_goal", isError: false }),
    );
  });

  it("keeps available and registered schemas paired with their tools", () => {
    const bridge = createCodexDynamicToolBridge({
      tools: [
        createTool({
          name: "message",
          parameters: {
            type: "object",
            properties: { current: { type: "string" } },
          },
        }),
      ],
      registeredTools: [
        createTool({
          name: "message",
          parameters: {
            type: "object",
            properties: { durable: { type: "string" } },
          },
        }),
      ],
      signal: new AbortController().signal,
    });

    expect(flattenSpecsWithNamespace(bridge.availableSpecs)[0]?.inputSchema).toEqual({
      type: "object",
      properties: { current: { type: "string" } },
    });
    expect(flattenSpecsWithNamespace(bridge.specs)[0]?.inputSchema).toEqual({
      type: "object",
      properties: { durable: { type: "string" } },
    });
  });

  it("quarantines dynamic tools with unsupported input schemas", async () => {
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const diagnosticEvents: DiagnosticEventPayload[] = [];
    const unsubscribeDiagnostics = onInternalDiagnosticEvent((event) =>
      diagnosticEvents.push(event),
    );
    const badExecute = vi.fn();
    let bridge!: ReturnType<typeof createCodexDynamicToolBridge>;
    try {
      bridge = createCodexDynamicToolBridge({
        tools: [
          createTool({ name: "message" }),
          createTool({
            name: "fuzzplugin_move_angles",
            parameters: { type: "array", items: { type: "number" } },
            execute: badExecute,
          }),
        ],
        signal: new AbortController().signal,
        hookContext: {
          agentId: "agent-quarantine",
          runId: "run-1",
          sessionId: "session-1",
          sessionKey: "global",
        },
      });
      await waitForDiagnosticEventsDrained();
    } finally {
      unsubscribeDiagnostics();
    }

    expect(specNames(bridge.availableSpecs)).toEqual(["message"]);
    expect(specNames(bridge.specs)).toEqual(["message"]);
    expect(bridge.telemetry.quarantinedTools).toEqual([
      {
        tool: "fuzzplugin_move_angles",
        violations: ['fuzzplugin_move_angles.inputSchema.type must be "object"'],
      },
    ]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("fuzzplugin_move_angles"),
      expect.objectContaining({
        tools: [
          {
            tool: "fuzzplugin_move_angles",
            violations: ['fuzzplugin_move_angles.inputSchema.type must be "object"'],
          },
        ],
      }),
    );
    const blockedEvents = diagnosticEvents.filter(
      (event): event is Extract<DiagnosticEventPayload, { type: "tool.execution.blocked" }> =>
        event.type === "tool.execution.blocked",
    );
    expect(blockedEvents).toContainEqual(
      expect.objectContaining({
        type: "tool.execution.blocked",
        agentId: "agent-quarantine",
        runId: "run-1",
        sessionId: "session-1",
        sessionKey: "global",
        toolName: "fuzzplugin_move_angles",
        deniedReason: "unsupported_tool_schema",
        reason: 'fuzzplugin_move_angles.inputSchema.type must be "object"',
      }),
    );

    const result = await bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      namespace: null,
      tool: "fuzzplugin_move_angles",
      arguments: {},
    });

    expect(result).toEqual({
      success: false,
      contentItems: [{ type: "inputText", text: "Unknown OpenClaw tool: fuzzplugin_move_angles" }],
    });
    expect(badExecute).not.toHaveBeenCalled();
  });

  it("quarantines unreadable dynamic tool descriptors without dropping healthy siblings", () => {
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const poisonedName = createTool({
      name: "fuzzplugin_unreadable_name",
      execute: vi.fn(),
    });
    Object.defineProperty(poisonedName, "name", {
      enumerable: true,
      get() {
        throw new Error("fuzzplugin dynamic tool name getter exploded");
      },
    });
    const poisonedSchema = createTool({
      name: "fuzzplugin_unreadable_schema",
      execute: vi.fn(),
    });
    Object.defineProperty(poisonedSchema, "parameters", {
      enumerable: true,
      get() {
        throw new Error("fuzzplugin dynamic tool schema getter exploded");
      },
    });
    const invalidName = createTool({
      name: "",
      execute: vi.fn(),
    });
    const poisonedExecute = createTool({
      name: "fuzzplugin_unreadable_execute",
    });
    Object.defineProperty(poisonedExecute, "execute", {
      enumerable: true,
      get() {
        throw new Error("fuzzplugin dynamic tool execute getter exploded");
      },
    });

    const bridge = createCodexDynamicToolBridge({
      tools: [
        poisonedName,
        poisonedSchema,
        invalidName,
        poisonedExecute,
        createTool({ name: "message" }),
      ],
      signal: new AbortController().signal,
    });

    expect(specNames(bridge.availableSpecs)).toEqual(["message"]);
    expect(specNames(bridge.specs)).toEqual(["message"]);
    expect(bridge.telemetry.quarantinedTools).toEqual([
      {
        tool: "tool[0]",
        violations: ["tool[0].name is unreadable"],
      },
      {
        tool: "fuzzplugin_unreadable_schema",
        violations: ["fuzzplugin_unreadable_schema.inputSchema is unreadable"],
      },
      {
        tool: "tool[2]",
        violations: ["tool[2].name must be a non-empty string"],
      },
      {
        tool: "fuzzplugin_unreadable_execute",
        violations: [
          "fuzzplugin_unreadable_execute could not be wrapped for before-tool-call hooks",
        ],
      },
    ]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "tool[0], fuzzplugin_unreadable_schema, tool[2], fuzzplugin_unreadable_execute",
      ),
      expect.objectContaining({
        tools: [
          {
            tool: "tool[0]",
            violations: ["tool[0].name is unreadable"],
          },
          {
            tool: "fuzzplugin_unreadable_schema",
            violations: ["fuzzplugin_unreadable_schema.inputSchema is unreadable"],
          },
          {
            tool: "tool[2]",
            violations: ["tool[2].name must be a non-empty string"],
          },
          {
            tool: "fuzzplugin_unreadable_execute",
            violations: [
              "fuzzplugin_unreadable_execute could not be wrapped for before-tool-call hooks",
            ],
          },
        ],
      }),
    );

    const registeredBridge = createCodexDynamicToolBridge({
      tools: [poisonedExecute, createTool({ name: "message" })],
      registeredTools: [
        createTool({ name: "fuzzplugin_unreadable_execute" }),
        createTool({ name: "message" }),
      ],
      signal: new AbortController().signal,
    });

    expect(specNames(registeredBridge.availableSpecs)).toEqual(["message"]);
    expect(specNames(registeredBridge.specs)).toEqual(["message"]);
  });

  it("can expose all dynamic tools directly for compatibility", () => {
    const bridge = createCodexDynamicToolBridge({
      tools: [createTool({ name: "web_search" }), createTool({ name: "message" })],
      signal: new AbortController().signal,
      loading: "direct",
    });

    expect(bridge.specs).toHaveLength(2);
    expectDynamicSpec(bridge.specs[0], { name: "web_search" });
    expectDynamicSpec(bridge.specs[1], { name: "message" });
    expectNoNamespace(bridge.specs[0]);
    expectNoNamespace(bridge.specs[1]);
  });

  it("truncates configured text tool results before returning them to Codex", async () => {
    const longText = "x".repeat(400);
    const bridge = createCodexDynamicToolBridge({
      tools: [
        createTool({
          name: "large_lookup",
          execute: vi.fn(async () => textToolResult(longText)),
        }),
      ],
      signal: new AbortController().signal,
      hookContext: {
        agentId: "main",
        config: {
          agents: {
            defaults: {
              contextLimits: {
                toolResultMaxChars: 180,
              },
            },
          },
        } as never,
      },
    });

    const result = await bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      namespace: null,
      tool: "large_lookup",
      arguments: {},
    });

    expect(result.success).toBe(true);
    const firstItem = result.contentItems[0];
    if (firstItem?.type !== "inputText" || typeof firstItem.text !== "string") {
      throw new Error("expected inputText tool result");
    }
    const text = firstItem.text;
    expect(text.length).toBeLessThanOrEqual(180);
    expect(text).toContain("OpenClaw truncated dynamic tool result");
    expect(text).toContain("original 400 chars");
    expect(text).toContain("rerun with narrower args");
  });

  it("keeps a whole code point when dynamic tool text crosses the configured boundary", async () => {
    const maxChars = 180;
    const totalChars = 400;
    const noticeText = `...(OpenClaw truncated dynamic tool result: original ${totalChars} chars, showing ${maxChars}; rerun with narrower args.)`;
    const textBudget = maxChars - noticeText.length - 1;
    const prefix = "a".repeat(textBudget - 1);
    const longText = `${prefix}😀${"z".repeat(totalChars - prefix.length - 2)}`;
    const bridge = createCodexDynamicToolBridge({
      tools: [
        createTool({
          name: "large_lookup",
          execute: vi.fn(async () => textToolResult(longText)),
        }),
      ],
      signal: new AbortController().signal,
      hookContext: {
        agentId: "main",
        config: {
          agents: { defaults: { contextLimits: { toolResultMaxChars: maxChars } } },
        } as never,
      },
    });

    const result = await bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      namespace: null,
      tool: "large_lookup",
      arguments: {},
    });

    expect(result.contentItems).toEqual([{ type: "inputText", text: `${prefix}\n${noticeText}` }]);
  });

  it("honors normalized per-agent dynamic tool result caps", async () => {
    const bridge = createCodexDynamicToolBridge({
      tools: [
        createTool({
          name: "large_lookup",
          execute: vi.fn(async () => textToolResult("x".repeat(400))),
        }),
      ],
      signal: new AbortController().signal,
      hookContext: {
        agentId: "research-bot",
        config: {
          agents: {
            defaults: {
              contextLimits: {
                toolResultMaxChars: 1_000,
              },
            },
            list: [
              {
                id: "Research Bot",
                contextLimits: {
                  toolResultMaxChars: 180,
                },
              },
            ],
          },
        } as never,
      },
    });

    const result = await bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      namespace: null,
      tool: "large_lookup",
      arguments: {},
    });

    expect(result.success).toBe(true);
    const firstItem = result.contentItems[0];
    if (firstItem?.type !== "inputText" || typeof firstItem.text !== "string") {
      throw new Error("expected inputText tool result");
    }
    expect(firstItem.text.length).toBeLessThanOrEqual(180);
    expect(firstItem.text).toContain("OpenClaw truncated dynamic tool result");
  });

  it("keeps truncation notices within tiny configured caps", async () => {
    const bridge = createCodexDynamicToolBridge({
      tools: [
        createTool({
          name: "large_lookup",
          execute: vi.fn(async () => textToolResult("x".repeat(400))),
        }),
      ],
      signal: new AbortController().signal,
      hookContext: {
        agentId: "main",
        config: {
          agents: {
            defaults: {
              contextLimits: {
                toolResultMaxChars: 32,
              },
            },
          },
        } as never,
      },
    });

    const result = await bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      namespace: null,
      tool: "large_lookup",
      arguments: {},
    });

    expect(result.success).toBe(true);
    const firstItem = result.contentItems[0];
    if (firstItem?.type !== "inputText" || typeof firstItem.text !== "string") {
      throw new Error("expected inputText tool result");
    }
    expect(firstItem.text.length).toBeLessThanOrEqual(32);
    expect(firstItem.text).toBe("...(OpenClaw truncated dynamic tool".slice(0, 32));
  });

  it("budgets configured truncation across all text result blocks", async () => {
    const bridge = createCodexDynamicToolBridge({
      tools: [
        createTool({
          name: "large_lookup",
          execute: vi.fn(async () => ({
            content: [
              { type: "text" as const, text: "a".repeat(200) },
              { type: "text" as const, text: "b".repeat(200) },
            ],
            details: {},
          })),
        }),
      ],
      signal: new AbortController().signal,
      hookContext: {
        agentId: "main",
        config: {
          agents: {
            defaults: {
              contextLimits: {
                toolResultMaxChars: 180,
              },
            },
          },
        } as never,
      },
    });

    const result = await bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      namespace: null,
      tool: "large_lookup",
      arguments: {},
    });

    expect(result.success).toBe(true);
    const text = result.contentItems
      .map((item) => (item.type === "inputText" && typeof item.text === "string" ? item.text : ""))
      .join("");
    expect(text.length).toBeLessThanOrEqual(180);
    expect(text).toContain("OpenClaw truncated dynamic tool result");
    expect(text).toContain("original 400 chars");
    expect(text).not.toContain("b".repeat(100));
  });

  it.each([
    { toolName: "tts", mediaUrl: "/tmp/reply.opus", audioAsVoice: true },
    { toolName: "image_generate", mediaUrl: "/tmp/generated.png" },
    { toolName: "video_generate", mediaUrl: "https://media.example/video.mp4" },
    { toolName: "music_generate", mediaUrl: "https://media.example/music.wav" },
  ])(
    "preserves structured media artifacts from $toolName tool results",
    async ({ toolName, mediaUrl, audioAsVoice }) => {
      const bridge = createBridgeWithToolResult(toolName, mediaResult(mediaUrl, audioAsVoice));

      const result = await bridge.handleToolCall({
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        namespace: null,
        tool: toolName,
        arguments: { prompt: "hello" },
      });

      expect(result).toEqual(expectInputText("Generated media reply."));
      expect(bridge.telemetry.toolMediaUrls).toEqual([mediaUrl]);
      expect(bridge.telemetry.toolAudioAsVoice).toBe(audioAsVoice === true);
    },
  );

  it("preserves audio-as-voice metadata from tts results", async () => {
    const toolResult = {
      content: [{ type: "text", text: "(spoken) hello" }],
      details: {
        media: {
          mediaUrl: "/tmp/reply.opus",
          audioAsVoice: true,
        },
      },
    } satisfies AgentToolResult<unknown>;
    const tool = createTool({
      execute: vi.fn(async () => toolResult),
    });
    const bridge = createCodexDynamicToolBridge({
      tools: [tool],
      signal: new AbortController().signal,
    });

    const result = await bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      namespace: null,
      tool: "tts",
      arguments: { text: "hello" },
    });

    expect(result).toEqual({
      success: true,
      contentItems: [{ type: "inputText", text: "(spoken) hello" }],
    });
    expect(bridge.telemetry.toolMediaUrls).toEqual(["/tmp/reply.opus"]);
    expect(bridge.telemetry.toolAudioAsVoice).toBe(true);
  });

  it("records messaging tool side effects while returning concise text to app-server", async () => {
    const toolResult = {
      content: [{ type: "text", text: "Sent." }],
      details: { messageId: "message-1" },
    } satisfies AgentToolResult<unknown>;
    const tool = createTool({
      name: "message",
      execute: vi.fn(async () => toolResult),
    });
    const bridge = createCodexDynamicToolBridge({
      tools: [tool],
      signal: new AbortController().signal,
    });

    const result = await handleMessageToolCall(bridge, {
      action: "send",
      text: "hello from Codex",
      mediaUrl: "/tmp/reply.png",
      provider: "telegram",
      to: "chat-1",
      threadId: "thread-ts-1",
    });

    expect(result).toEqual(expectInputText("Sent."));
    expect(bridge.telemetry.didSendViaMessagingTool).toBe(true);
    expect(bridge.telemetry.messagingToolSentTexts).toEqual(["hello from Codex"]);
    expect(bridge.telemetry.messagingToolSentMediaUrls).toEqual(["/tmp/reply.png"]);
    expect(bridge.telemetry.messagingToolSentTargets).toEqual([
      {
        tool: "message",
        provider: "telegram",
        to: "chat-1",
        threadId: "thread-ts-1",
        text: "hello from Codex",
        mediaUrls: ["/tmp/reply.png"],
      },
    ]);
  });

  it("records hook-adjusted message arguments as delivery telemetry", async () => {
    const beforeToolCall = vi.fn(async () => ({
      params: {
        action: "send",
        text: "rewritten delivery",
        mediaUrl: "/tmp/rewritten.png",
        provider: "telegram",
        to: "chat-rewritten",
      },
    }));
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: beforeToolCall }]),
    );
    const execute = vi.fn(async () => textToolResult("Sent."));
    const bridge = createCodexDynamicToolBridge({
      tools: [createTool({ name: "message", execute })],
      signal: new AbortController().signal,
    });

    await handleMessageToolCall(bridge, { action: "status" });

    expect(execute).toHaveBeenCalledWith(
      expect.any(String),
      {
        action: "send",
        text: "rewritten delivery",
        mediaUrl: "/tmp/rewritten.png",
        provider: "telegram",
        to: "chat-rewritten",
      },
      expect.any(AbortSignal),
      undefined,
    );
    expect(bridge.telemetry.messagingToolSentTexts).toEqual(["rewritten delivery"]);
    expect(bridge.telemetry.messagingToolSentMediaUrls).toEqual(["/tmp/rewritten.png"]);
    expect(bridge.telemetry.messagingToolSentTargets).toEqual([
      {
        tool: "message",
        provider: "telegram",
        to: "chat-rewritten",
        threadId: undefined,
        text: "rewritten delivery",
        mediaUrls: ["/tmp/rewritten.png"],
      },
    ]);
  });

  it("records the current provider and transport thread for implicit message sends", async () => {
    const hasRepliedRef = { value: false };
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "slack",
          plugin: {
            id: "slack",
            messaging: { normalizeTarget: (raw: string) => raw.trim().toLowerCase() },
            threading: {
              resolveAutoThreadId: ({
                to,
                toolContext,
              }: {
                to: string;
                toolContext?: {
                  currentChannelId?: string;
                  currentMessagingTarget?: string;
                  currentThreadTs?: string;
                  replyToMode?: "off" | "first" | "all" | "batched";
                  hasRepliedRef?: { value: boolean };
                };
              }) => {
                if (
                  to !== toolContext?.currentMessagingTarget &&
                  to !== toolContext?.currentChannelId
                ) {
                  return undefined;
                }
                if (
                  (toolContext?.replyToMode === "first" ||
                    toolContext?.replyToMode === "batched") &&
                  !toolContext.hasRepliedRef?.value
                ) {
                  return toolContext.currentThreadTs;
                }
                return undefined;
              },
            },
          },
          source: "test",
        },
      ]),
    );
    const bridge = createCodexDynamicToolBridge({
      tools: [
        createTool({
          name: "message",
          execute: vi.fn(async () => {
            hasRepliedRef.value = true;
            return textToolResult("Sent.");
          }),
        }),
      ],
      signal: new AbortController().signal,
      hookContext: {
        currentChannelProvider: "slack",
        currentChannelId: "D1",
        currentMessagingTarget: "user:u1",
        currentThreadId: "171.222",
        replyToMode: "first",
        hasRepliedRef,
      },
    });

    await handleMessageToolCall(bridge, {
      action: "send",
      to: "user:U1",
      text: "hello from Codex",
    });

    expect(bridge.telemetry.messagingToolSentTargets).toEqual([
      {
        tool: "message",
        provider: "slack",
        to: "user:u1",
        threadId: "171.222",
        threadImplicit: true,
        text: "hello from Codex",
      },
    ]);
  });

  it("records the provider-confirmed route for successful message sends", async () => {
    const registry = createTestRegistry([
      {
        pluginId: "mattermost",
        plugin: {
          id: "mattermost",
          messaging: { normalizeTarget: (raw: string) => raw.trim().toLowerCase() },
          actions: {
            extractToolSend: ({ args }: { args: Record<string, unknown> }) =>
              args.action === "send" && typeof args.to === "string"
                ? { to: args.to, threadImplicit: true }
                : null,
            extractToolSendResult: ({ result }: { result: unknown }) => {
              const details = requireRecord(
                requireRecord(result, "message result").details,
                "message details",
              );
              const toolSend = requireRecord(details.toolSend, "tool send details");
              return {
                to: String(toolSend.to),
                threadId: String(toolSend.threadId),
              };
            },
          },
        },
        source: "test",
      },
    ]);
    const middleware = vi.fn(async (event: { result: AgentToolResult<unknown> }) => {
      const details = requireRecord(event.result.details, "middleware details");
      const toolSend = requireRecord(details.toolSend, "middleware tool send");
      toolSend.to = "channel:corrupted";
      toolSend.threadId = "corrupted-root";
      return undefined;
    });
    registry.agentToolResultMiddlewares.push({
      pluginId: "route-details-stripper",
      pluginName: "Route details stripper",
      rawHandler: middleware,
      handler: middleware,
      runtimes: ["codex"],
      source: "test",
    });
    setActivePluginRegistry(registry);
    const bridge = createBridgeWithToolResult(
      "message",
      textToolResult("Sent.", {
        toolSend: {
          to: "channel:resolved-id",
          threadId: "root-post-id",
        },
      }),
    );

    await handleMessageToolCall(bridge, {
      action: "send",
      provider: "mattermost",
      to: "town-square",
      text: "hello from Codex",
    });

    expect(bridge.telemetry.messagingToolSentTargets).toEqual([
      {
        tool: "message",
        provider: "mattermost",
        to: "channel:resolved-id",
        threadId: "root-post-id",
        threadImplicit: undefined,
        threadSuppressed: undefined,
        text: "hello from Codex",
      },
    ]);
  });

  it("records message tool media attachment aliases as delivery evidence", async () => {
    const toolResult = {
      content: [{ type: "text", text: "Sent." }],
      details: { messageId: "message-1" },
    } satisfies AgentToolResult<unknown>;
    const tool = createTool({
      name: "message",
      execute: vi.fn(async () => toolResult),
    });
    const bridge = createCodexDynamicToolBridge({
      tools: [tool],
      signal: new AbortController().signal,
    });

    const result = await handleMessageToolCall(bridge, {
      action: "send",
      text: "song attached",
      media: "/tmp/generated-song.mp3",
      attachments: [{ filePath: "/tmp/generated-cover.png" }],
    });

    expect(result).toEqual(expectInputText("Sent."));
    expect(bridge.telemetry.didSendViaMessagingTool).toBe(true);
    expect(bridge.telemetry.messagingToolSentMediaUrls).toEqual([
      "/tmp/generated-song.mp3",
      "/tmp/generated-cover.png",
    ]);
    expect(bridge.telemetry.messagingToolSentTargets).toEqual([
      {
        tool: "message",
        provider: "message",
        to: undefined,
        threadId: undefined,
        text: "song attached",
        mediaUrls: ["/tmp/generated-song.mp3", "/tmp/generated-cover.png"],
      },
    ]);
  });

  it("records internal UI source replies separately from outbound messaging evidence", async () => {
    const toolResult = textToolResult("Sent to current chat.", {
      status: "ok",
      deliveryStatus: "sent",
      sourceReplySink: "internal-ui",
      sourceReply: {
        text: "visible reply",
        mediaUrls: ["/tmp/reply.png"],
      },
    });
    const bridge = createBridgeWithToolResult("message", toolResult);

    const result = await handleMessageToolCall(bridge, {
      action: "send",
      message: "<think>private</think>visible reply",
    });

    expect(result).toEqual(expectInputText("Sent to current chat."));
    expect(bridge.telemetry.didSendViaMessagingTool).toBe(true);
    expect(bridge.telemetry.messagingToolSentTexts).toEqual([]);
    expect(bridge.telemetry.messagingToolSentMediaUrls).toEqual([]);
    expect(bridge.telemetry.messagingToolSentTargets).toEqual([]);
    expect(bridge.telemetry.messagingToolSourceReplyPayloads).toEqual([
      {
        text: "visible reply",
        mediaUrl: "/tmp/reply.png",
        mediaUrls: ["/tmp/reply.png"],
      },
    ]);
  });

  it("marks delivered message-tool-only source replies as terminal", async () => {
    const bridge = createBridgeWithToolResult(
      "message",
      textToolResult("Sent.", { messageId: "imessage-6264" }),
      { sourceReplyDeliveryMode: "message_tool_only" },
    );

    const result = await handleMessageToolCall(bridge, {
      action: "send",
      message: "visible reply",
    });

    expect(result).toEqual(expectInputText("Sent."));
    expect(result.terminate).toBe(true);
    expect(bridge.telemetry.didDeliverSourceReplyViaMessageTool).toBe(true);
    expect(Object.keys(result)).not.toContain("terminate");
  });

  it("keeps message-tool-only source replies terminal when middleware redacts receipt details", async () => {
    const registry = createEmptyPluginRegistry();
    registry.agentToolResultMiddlewares.push({
      pluginId: "receipt-redactor",
      pluginName: "Receipt redactor",
      rawHandler: () => undefined,
      handler: (event: { result: AgentToolResult<unknown> }) => ({
        result: {
          content: event.result.content,
          details: { redacted: true },
        },
      }),
      runtimes: ["codex"],
      source: "test",
    });
    setActivePluginRegistry(registry);
    const bridge = createBridgeWithToolResult(
      "message",
      textToolResult("Sent.", {
        receipt: {
          primaryPlatformMessageId: "imessage-6264",
          platformMessageIds: ["imessage-6264"],
        },
      }),
      { sourceReplyDeliveryMode: "message_tool_only" },
    );

    const result = await handleMessageToolCall(bridge, {
      action: "send",
      message: "visible reply",
    });

    expect(result).toEqual(expectInputText("Sent."));
    expect(result.terminate).toBe(true);
    expect(Object.keys(result)).not.toContain("terminate");
  });

  it("does not treat target telemetry alone as delivered message-tool-only source reply evidence", async () => {
    const bridge = createBridgeWithToolResult("message", textToolResult("Sent."), {
      sourceReplyDeliveryMode: "message_tool_only",
      currentChannelProvider: "imessage",
      currentChannelId: "chat-1",
    });

    const result = await handleMessageToolCall(bridge, {
      action: "send",
      message: "visible reply",
    });

    expect(result).toEqual(expectInputText("Sent."));
    expect(bridge.telemetry.messagingToolSentTargets).toEqual([
      expect.objectContaining({
        tool: "message",
        provider: "imessage",
        to: "chat-1",
        text: "visible reply",
      }),
    ]);
    expect(result.terminate).toBeUndefined();
    expect(bridge.telemetry.didDeliverSourceReplyViaMessageTool).toBe(false);
  });

  it("keeps message-tool-only source replies terminal for explicit current source routes", async () => {
    const bridge = createBridgeWithToolResult(
      "message",
      textToolResult("Sent.", { ok: true, messageId: "imessage-853" }),
      {
        sourceReplyDeliveryMode: "message_tool_only",
        currentChannelProvider: "imessage",
        currentChannelId: "imessage:+12069106512",
        currentMessagingTarget: "+12069106512",
      },
    );

    const result = await handleMessageToolCall(bridge, {
      action: "reply",
      channel: "imessage",
      target: "+12069106512",
      messageId: "853",
      message: "visible reply",
      buttons: [],
    });

    expect(result).toEqual(expectInputText("Sent."));
    expect(result.terminate).toBe(true);
    expect(bridge.telemetry.didDeliverSourceReplyViaMessageTool).toBe(true);
    expect(Object.keys(result)).not.toContain("terminate");
  });

  it("keeps normalized explicit source routes terminal", async () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "sms",
          plugin: {
            id: "sms",
            messaging: {
              normalizeTarget: (raw: string) => {
                const digits = raw.replace(/\D/gu, "");
                return digits.length === 11 && digits.startsWith("1") ? `+${digits}` : raw.trim();
              },
            },
          },
          source: "test",
        },
      ]),
    );
    const bridge = createBridgeWithToolResult(
      "message",
      textToolResult("Sent.", { ok: true, messageId: "sms-853" }),
      {
        sourceReplyDeliveryMode: "message_tool_only",
        currentChannelProvider: "sms",
        currentChannelId: "sms:+12069106512",
        currentMessagingTarget: "+12069106512",
      },
    );

    const result = await handleMessageToolCall(bridge, {
      action: "reply",
      channel: "sms",
      target: "+1 (206) 910-6512",
      messageId: "853",
      message: "visible reply",
    });

    expect(result).toEqual(expectInputText("Sent."));
    expect(bridge.telemetry.messagingToolSentTargets).toEqual([
      expect.objectContaining({
        tool: "message",
        provider: "sms",
        to: "+12069106512",
        text: "visible reply",
      }),
    ]);
    expect(result.terminate).toBe(true);
    expect(bridge.telemetry.didDeliverSourceReplyViaMessageTool).toBe(true);
    expect(Object.keys(result)).not.toContain("terminate");
  });

  it("keeps message-tool-only source replies terminal when the reply receipt matches the current message id", async () => {
    const bridge = createBridgeWithToolResult(
      "message",
      textToolResult("Sent.", {
        ok: true,
        messageId: "provider-message-1",
        repliedTo: "provider-guid-857",
      }),
      {
        sourceReplyDeliveryMode: "message_tool_only",
        currentChannelProvider: "imessage",
        currentChannelId: "imessage:any;-;+12069106512",
        currentMessageId: "provider-guid-857",
      },
    );

    const result = await handleMessageToolCall(bridge, {
      action: "reply",
      channel: "imessage",
      target: "+12069106512",
      messageId: "857",
      message: "visible reply",
      buttons: [],
    });

    expect(result).toEqual(expectInputText("Sent."));
    expect(bridge.telemetry.messagingToolSentTargets).toEqual([
      expect.objectContaining({
        tool: "message",
        provider: "imessage",
        to: "+12069106512",
        text: "visible reply",
      }),
    ]);
    expect(result.terminate).toBe(true);
    expect(bridge.telemetry.didDeliverSourceReplyViaMessageTool).toBe(true);
    expect(Object.keys(result)).not.toContain("terminate");
  });

  it("keeps message-tool-only source replies terminal when a text receipt matches the current message id", async () => {
    const receiptText = JSON.stringify({
      ok: true,
      messageId: "provider-message-1",
      repliedTo: "provider-guid-861",
    });
    const bridge = createBridgeWithToolResult("message", textToolResult(receiptText), {
      sourceReplyDeliveryMode: "message_tool_only",
      currentChannelProvider: "imessage",
      currentChannelId: "imessage:any;-;+12069106512",
      currentMessageId: "provider-guid-861",
    });

    const result = await handleMessageToolCall(bridge, {
      action: "reply",
      channel: "imessage",
      target: "+12069106512",
      messageId: "861",
      message: "visible reply",
      buttons: [],
    });

    expect(result).toEqual(expectInputText(receiptText));
    expect(result.terminate).toBe(true);
    expect(bridge.telemetry.didDeliverSourceReplyViaMessageTool).toBe(true);
    expect(Object.keys(result)).not.toContain("terminate");
  });

  it("does not let dry-run reply receipts terminate message-tool-only source replies", async () => {
    const receiptText = JSON.stringify({
      deliveryStatus: "dry_run",
      dryRun: true,
      replyToId: "provider-guid-862",
    });
    const bridge = createBridgeWithToolResult("message", textToolResult(receiptText), {
      sourceReplyDeliveryMode: "message_tool_only",
      currentChannelProvider: "imessage",
      currentChannelId: "imessage:any;-;+12069106512",
      currentMessageId: "provider-guid-862",
    });

    const result = await handleMessageToolCall(bridge, {
      action: "reply",
      channel: "imessage",
      target: "+12069106512",
      messageId: "862",
      message: "visible reply",
      buttons: [],
    });

    expect(result).toEqual(expectInputText(receiptText));
    expect(result.terminate).toBeUndefined();
    expect(bridge.telemetry.didDeliverSourceReplyViaMessageTool).toBe(false);
  });

  it("does not record dry-run reply actions as committed sends", async () => {
    const bridge = createBridgeWithToolResult(
      "message",
      textToolResult("Dry run.", {
        deliveryStatus: "dry_run",
        dryRun: true,
      }),
      {
        sourceReplyDeliveryMode: "message_tool_only",
        currentChannelProvider: "imessage",
        currentChannelId: "imessage:+12069106512",
        currentMessagingTarget: "+12069106512",
        currentMessageId: "provider-guid-862",
      },
    );

    const result = await handleMessageToolCall(bridge, {
      action: "reply",
      channel: "imessage",
      target: "+12069106512",
      messageId: "862",
      message: "visible reply",
    });

    expect(result).toEqual(expectInputText("Dry run."));
    expect(result.terminate).toBeUndefined();
    expect(bridge.telemetry.didSendViaMessagingTool).toBe(false);
    expect(bridge.telemetry.messagingToolSentTargets).toEqual([]);
    expect(bridge.telemetry.didDeliverSourceReplyViaMessageTool).toBe(false);
  });

  it("keeps message-tool-only source replies terminal for explicit native target segments", async () => {
    const bridge = createBridgeWithToolResult("message", textToolResult("Sent.", { ok: true }), {
      sourceReplyDeliveryMode: "message_tool_only",
      currentChannelProvider: "imessage",
      currentChannelId: "imessage:any;-;+12069106512",
    });

    const result = await handleMessageToolCall(bridge, {
      action: "reply",
      channel: "imessage",
      target: "+12069106512",
      messageId: "863",
      message: "visible reply",
      buttons: [],
    });

    expect(result).toEqual(expectInputText("Sent."));
    expect(result.terminate).toBe(true);
    expect(bridge.telemetry.didDeliverSourceReplyViaMessageTool).toBe(true);
    expect(Object.keys(result)).not.toContain("terminate");
  });

  it("keeps message-tool-only source replies terminal when the provider is only in the current channel id", async () => {
    const bridge = createBridgeWithToolResult("message", textToolResult("Sent.", { ok: true }), {
      sourceReplyDeliveryMode: "message_tool_only",
      currentChannelId: "imessage:any;-;+12069106512",
    });

    const result = await handleMessageToolCall(bridge, {
      action: "reply",
      channel: "imessage",
      target: "+12069106512",
      messageId: "865",
      message: "visible reply",
      buttons: [],
    });

    expect(result).toEqual(expectInputText("Sent."));
    expect(result.terminate).toBe(true);
    expect(bridge.telemetry.didDeliverSourceReplyViaMessageTool).toBe(true);
    expect(Object.keys(result)).not.toContain("terminate");
  });

  it("records message-tool-owned terminal replies as delivered source replies", async () => {
    const bridge = createBridgeWithToolResult(
      "message",
      {
        ...textToolResult("Sent.", { ok: true }),
        terminate: true,
      } as AgentToolResult<unknown>,
      { sourceReplyDeliveryMode: "message_tool_only" },
    );

    const result = await handleMessageToolCall(bridge, {
      action: "reply",
      channel: "imessage",
      target: "+12069106512",
      messageId: "867",
      message: "visible reply",
      buttons: [],
    });

    expect(result).toEqual(expectInputText("Sent."));
    expect(result.terminate).toBe(true);
    expect(bridge.telemetry.didDeliverSourceReplyViaMessageTool).toBe(true);
    expect(Object.keys(result)).not.toContain("terminate");
  });

  it("does not treat bare send telemetry as delivered message-tool-only source reply evidence", async () => {
    const bridge = createBridgeWithToolResult("message", textToolResult("Sent."), {
      sourceReplyDeliveryMode: "message_tool_only",
    });

    const result = await handleMessageToolCall(bridge, {
      action: "send",
      message: "visible reply",
    });

    expect(result).toEqual(expectInputText("Sent."));
    expect(bridge.telemetry.didSendViaMessagingTool).toBe(true);
    expect(result.terminate).toBeUndefined();
    expect(bridge.telemetry.didDeliverSourceReplyViaMessageTool).toBe(false);
  });

  it("does not let prior message-send telemetry terminate a later non-delivery tool result", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce(textToolResult("Sent.", { messageId: "source-reply-1" }))
      .mockResolvedValueOnce(textToolResult("No message sent.", { ok: true }));
    const bridge = createCodexDynamicToolBridge({
      tools: [createTool({ name: "message", execute })],
      signal: new AbortController().signal,
      hookContext: { sourceReplyDeliveryMode: "message_tool_only" },
    });

    const firstResult = await handleMessageToolCall(bridge, {
      action: "send",
      message: "visible reply",
    });
    const secondResult = await bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-2",
      namespace: null,
      tool: "message",
      arguments: { action: "inspect" },
    });

    expect(firstResult.terminate).toBe(true);
    expect(bridge.telemetry.didSendViaMessagingTool).toBe(true);
    expect(secondResult).toEqual(expectInputText("No message sent."));
    expect(secondResult.terminate).toBeUndefined();
  });

  it("does not mark explicit message-tool sends as terminal source replies", async () => {
    const bridge = createBridgeWithToolResult(
      "message",
      textToolResult("Sent.", { messageId: "other-chat-message" }),
      { sourceReplyDeliveryMode: "message_tool_only" },
    );

    const result = await handleMessageToolCall(bridge, {
      action: "send",
      target: "channel:other",
      message: "cross-channel reply",
    });

    expect(result).toEqual(expectInputText("Sent."));
    expect(result.terminate).toBeUndefined();
    expect(bridge.telemetry.didDeliverSourceReplyViaMessageTool).toBe(false);
  });

  it("does not mark mismatched explicit message-tool sends as terminal source replies", async () => {
    const bridge = createBridgeWithToolResult("message", textToolResult("Sent."), {
      sourceReplyDeliveryMode: "message_tool_only",
      currentChannelProvider: "imessage",
      currentChannelId: "imessage:+12069106512",
      currentMessagingTarget: "+12069106512",
    });

    const result = await handleMessageToolCall(bridge, {
      action: "reply",
      channel: "slack",
      target: "+12069106512",
      messageId: "853",
      message: "cross-provider reply",
    });

    expect(result).toEqual(expectInputText("Sent."));
    expect(result.terminate).toBeUndefined();
    expect(bridge.telemetry.didDeliverSourceReplyViaMessageTool).toBe(false);
  });

  it("does not mark same-target sibling-thread replies as terminal source replies", async () => {
    const bridge = createBridgeWithToolResult("message", textToolResult("Sent.", { ok: true }), {
      sourceReplyDeliveryMode: "message_tool_only",
      currentChannelProvider: "slack",
      currentChannelId: "slack:C123",
      currentMessagingTarget: "C123",
      currentThreadId: "171.222",
    });

    const result = await handleMessageToolCall(bridge, {
      action: "reply",
      channel: "slack",
      target: "C123",
      threadId: "171.333",
      message: "sibling thread reply",
    });

    expect(result).toEqual(expectInputText("Sent."));
    expect(result.terminate).toBeUndefined();
    expect(bridge.telemetry.didDeliverSourceReplyViaMessageTool).toBe(false);
  });

  it("does not mark implicit-target sibling-thread replies as terminal source replies", async () => {
    const bridge = createBridgeWithToolResult("message", textToolResult("Sent.", { ok: true }), {
      sourceReplyDeliveryMode: "message_tool_only",
      currentChannelProvider: "slack",
      currentChannelId: "slack:C123",
      currentMessagingTarget: "C123",
      currentThreadId: "171.222",
    });

    const result = await handleMessageToolCall(bridge, {
      action: "reply",
      channel: "slack",
      threadId: "171.333",
      message: "sibling thread reply",
    });

    expect(result).toEqual(expectInputText("Sent."));
    expect(result.terminate).toBeUndefined();
    expect(bridge.telemetry.didDeliverSourceReplyViaMessageTool).toBe(false);
  });

  it("does not mark top-level source replies with explicit thread routes as terminal", async () => {
    const bridge = createBridgeWithToolResult("message", textToolResult("Sent.", { ok: true }), {
      sourceReplyDeliveryMode: "message_tool_only",
      currentChannelProvider: "slack",
      currentChannelId: "slack:C123",
      currentMessagingTarget: "C123",
    });

    const result = await handleMessageToolCall(bridge, {
      action: "reply",
      channel: "slack",
      target: "C123",
      threadId: "171.333",
      message: "thread reply from top-level source",
    });

    expect(result).toEqual(expectInputText("Sent."));
    expect(result.terminate).toBeUndefined();
    expect(bridge.telemetry.didDeliverSourceReplyViaMessageTool).toBe(false);
  });

  it("does not let matching reply receipts override explicit non-source routes", async () => {
    const bridge = createBridgeWithToolResult(
      "message",
      textToolResult("Sent.", {
        ok: true,
        messageId: "other-chat-message",
        repliedTo: "provider-guid-853",
      }),
      {
        sourceReplyDeliveryMode: "message_tool_only",
        currentChannelProvider: "imessage",
        currentChannelId: "imessage:+12069106512",
        currentMessagingTarget: "+12069106512",
        currentMessageId: "provider-guid-853",
      },
    );

    const result = await handleMessageToolCall(bridge, {
      action: "reply",
      channel: "imessage",
      target: "other-chat",
      message: "cross-channel reply",
    });

    expect(result).toEqual(expectInputText("Sent."));
    expect(result.terminate).toBeUndefined();
    expect(bridge.telemetry.didDeliverSourceReplyViaMessageTool).toBe(false);
  });

  it("does not let provider target aliases override source routes", async () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "slack",
          plugin: {
            id: "slack",
            messaging: { normalizeTarget: (raw: string) => raw.trim().toLowerCase() },
            actions: {
              messageActionTargetAliases: {
                reply: {
                  aliases: ["chatGuid"],
                  deliveryTargetAliases: ["chatGuid"],
                },
              },
            },
          },
          source: "test",
        },
      ]),
    );
    const bridge = createBridgeWithToolResult("message", textToolResult("Sent.", { ok: true }), {
      sourceReplyDeliveryMode: "message_tool_only",
      currentChannelProvider: "slack",
      currentChannelId: "channel:c1",
      currentMessagingTarget: "channel:c1",
      currentMessageId: "provider-guid-854",
    });

    const result = await handleMessageToolCall(bridge, {
      action: "reply",
      channel: "slack",
      chatGuid: "Channel:C2",
      messageId: "854",
      message: "cross-chat reply",
    });

    expect(result).toEqual(expectInputText("Sent."));
    expect(bridge.telemetry.messagingToolSentTargets).toEqual([
      expect.objectContaining({
        tool: "message",
        provider: "slack",
        to: "channel:c2",
        text: "cross-chat reply",
      }),
    ]);
    expect(result.terminate).toBeUndefined();
    expect(bridge.telemetry.didDeliverSourceReplyViaMessageTool).toBe(false);
  });

  it("does not record messaging side effects when the send fails", async () => {
    const tool = createTool({
      name: "message",
      execute: vi.fn(async () => {
        throw new Error("send failed");
      }),
    });
    const bridge = createCodexDynamicToolBridge({
      tools: [tool],
      signal: new AbortController().signal,
    });

    const result = await handleMessageToolCall(bridge, {
      action: "send",
      text: "not delivered",
      provider: "slack",
      to: "C123",
    });

    expect(result).toEqual({
      success: false,
      contentItems: [{ type: "inputText", text: "send failed" }],
    });
    expect(bridge.telemetry.didSendViaMessagingTool).toBe(false);
    expect(bridge.telemetry.messagingToolSentTexts).toEqual([]);
    expect(bridge.telemetry.messagingToolSentMediaUrls).toEqual([]);
    expect(bridge.telemetry.messagingToolSentTargets).toEqual([]);
  });

  it("records heartbeat response tool outcomes", async () => {
    const bridge = createBridgeWithToolResult(
      HEARTBEAT_RESPONSE_TOOL_NAME,
      textToolResult("Recorded.", {
        status: "recorded",
        outcome: "needs_attention",
        notify: true,
        summary: "Build is blocked.",
        notificationText: "Build is blocked on missing credentials.",
        priority: "high",
      }),
    );

    const result = await bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      namespace: null,
      tool: HEARTBEAT_RESPONSE_TOOL_NAME,
      arguments: {},
    });

    expect(result).toEqual(expectInputText("Recorded."));
    expect(bridge.telemetry.heartbeatToolResponse).toEqual({
      outcome: "needs_attention",
      notify: true,
      summary: "Build is blocked.",
      notificationText: "Build is blocked on missing credentials.",
      priority: "high",
    });
  });

  it("applies agent tool result middleware from the active plugin registry", async () => {
    const registry = createEmptyPluginRegistry();
    const handler = vi.fn(
      async (event: { result: AgentToolResult<unknown>; toolName: string }) => ({
        result: {
          ...event.result,
          content: [{ type: "text" as const, text: `${event.toolName} compacted` }],
        },
      }),
    );
    registry.agentToolResultMiddlewares.push({
      pluginId: "tokenjuice",
      pluginName: "Tokenjuice",
      rawHandler: handler,
      handler,
      runtimes: ["codex"],
      source: "test",
    });
    setActivePluginRegistry(registry);

    const bridge = createBridgeWithToolResult("exec", {
      content: [{ type: "text", text: "raw output" }],
      details: {},
    });

    const result = await bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      namespace: null,
      tool: "exec",
      arguments: { command: "git status" },
    });

    expect(result).toEqual(expectInputText("exec compacted"));
    const event = requireRecord(callArg(handler, 0, 0, "middleware event"), "middleware event");
    expect(event.threadId).toBe("thread-1");
    expect(event.turnId).toBe("turn-1");
    expect(event.toolCallId).toBe("call-1");
    expect(event.toolName).toBe("exec");
    expect(event.args).toEqual({ command: "git status" });
    expectContextFields(callArg(handler, 0, 1, "middleware context"), { runtime: "codex" });
  });

  it("expires the current computer frame when middleware removes its screenshot", async () => {
    const registry = createEmptyPluginRegistry();
    const handler = vi.fn(async (event: { result: AgentToolResult<unknown> }) => ({
      result: {
        ...event.result,
        content: [{ type: "text" as const, text: "screenshot removed" }],
      },
    }));
    registry.agentToolResultMiddlewares.push({
      pluginId: "tokenjuice",
      pluginName: "Tokenjuice",
      rawHandler: handler,
      handler,
      runtimes: ["codex"],
      source: "test",
    });
    setActivePluginRegistry(registry);
    const computerContextEpoch: {
      value: number;
      frameToolCallId?: string;
      frameImageIdentity?: string;
    } = { value: 0 };
    const bridge = createCodexDynamicToolBridge({
      tools: [
        createTool({
          name: "computer",
          execute: vi.fn(async (toolCallId: string) => {
            computerContextEpoch.frameToolCallId = toolCallId;
            computerContextEpoch.frameImageIdentity = frameImageIdentity(COMPUTER_FRAME_IMAGE);
            return {
              content: [
                { type: "image" as const, data: COMPUTER_FRAME_IMAGE, mimeType: "image/png" },
              ],
              details: {},
            };
          }),
        }),
      ],
      signal: new AbortController().signal,
      computerContextEpoch,
    });

    const result = await bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "shot-1",
      namespace: null,
      tool: "computer",
      arguments: { action: "screenshot" },
    });

    expect(result).toEqual(expectInputText("screenshot removed"));
    expect(computerContextEpoch).toEqual({ value: 1 });
  });

  it("expires the current computer frame when middleware swaps its screenshot", async () => {
    const registry = createEmptyPluginRegistry();
    const handler = vi.fn(async (event: { result: AgentToolResult<unknown> }) => ({
      result: {
        ...event.result,
        content: [{ type: "image" as const, data: REPLACEMENT_FRAME_IMAGE, mimeType: "image/png" }],
      },
    }));
    registry.agentToolResultMiddlewares.push({
      pluginId: "tokenjuice",
      pluginName: "Tokenjuice",
      rawHandler: handler,
      handler,
      runtimes: ["codex"],
      source: "test",
    });
    setActivePluginRegistry(registry);
    const computerContextEpoch: {
      value: number;
      frameToolCallId?: string;
      frameImageIdentity?: string;
    } = { value: 0 };
    const bridge = createCodexDynamicToolBridge({
      tools: [
        createTool({
          name: "computer",
          execute: vi.fn(async (toolCallId: string) => {
            computerContextEpoch.frameToolCallId = toolCallId;
            computerContextEpoch.frameImageIdentity = frameImageIdentity(COMPUTER_FRAME_IMAGE);
            return {
              content: [
                { type: "image" as const, data: COMPUTER_FRAME_IMAGE, mimeType: "image/png" },
              ],
              details: {},
            };
          }),
        }),
      ],
      signal: new AbortController().signal,
      computerContextEpoch,
    });

    const result = await bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "shot-1",
      namespace: null,
      tool: "computer",
      arguments: { action: "screenshot" },
    });

    expect(result.contentItems).toEqual([
      {
        type: "inputImage",
        imageUrl: `data:image/png;base64,${REPLACEMENT_FRAME_IMAGE}`,
      },
    ]);
    expect(computerContextEpoch).toEqual({ value: 1 });
  });

  it("expires a computer frame when screenshot result middleware throws", async () => {
    const registry = createEmptyPluginRegistry();
    const handler = vi.fn(async () => {
      throw new Error("middleware exploded");
    });
    registry.agentToolResultMiddlewares.push({
      pluginId: "broken-redactor",
      pluginName: "Broken redactor",
      rawHandler: handler,
      handler,
      runtimes: ["codex"],
      source: "test",
    });
    setActivePluginRegistry(registry);
    const computerContextEpoch: {
      value: number;
      frameToolCallId?: string;
      frameImageIdentity?: string;
    } = { value: 0 };
    const bridge = createCodexDynamicToolBridge({
      tools: [
        createTool({
          name: "computer",
          execute: vi.fn(async (toolCallId: string) => {
            computerContextEpoch.frameToolCallId = toolCallId;
            computerContextEpoch.frameImageIdentity = frameImageIdentity(COMPUTER_FRAME_IMAGE);
            return {
              content: [
                { type: "image" as const, data: COMPUTER_FRAME_IMAGE, mimeType: "image/png" },
              ],
              details: {},
            };
          }),
        }),
      ],
      signal: new AbortController().signal,
      computerContextEpoch,
    });

    const result = await bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "shot-1",
      namespace: null,
      tool: "computer",
      arguments: { action: "screenshot" },
    });

    expect(result.success).toBe(false);
    expect(result.contentItems).toEqual([
      { type: "inputText", text: "Tool output unavailable due to post-processing error." },
    ]);
    expect(handler).toHaveBeenCalledOnce();
    expect(computerContextEpoch).toEqual({ value: 1 });
  });

  it("keeps the current computer frame when middleware preserves its exact screenshot", async () => {
    const computerContextEpoch = {
      value: 0,
      frameToolCallId: "shot-1",
      frameImageIdentity: frameImageIdentity(COMPUTER_FRAME_IMAGE),
    };
    const bridge = createCodexDynamicToolBridge({
      tools: [
        createTool({
          name: "computer",
          execute: vi.fn(async () => ({
            content: [
              { type: "image" as const, data: COMPUTER_FRAME_IMAGE, mimeType: "image/png" },
            ],
            details: {},
          })),
        }),
      ],
      signal: new AbortController().signal,
      computerContextEpoch,
    });

    await bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "shot-1",
      namespace: null,
      tool: "computer",
      arguments: { action: "screenshot" },
    });

    expect(computerContextEpoch).toEqual({
      value: 0,
      frameToolCallId: "shot-1",
      frameImageIdentity: frameImageIdentity(COMPUTER_FRAME_IMAGE),
    });
  });

  it("does not expire a newer computer frame for an older text-only result", async () => {
    const computerContextEpoch = { value: 2, frameToolCallId: "shot-newer" };
    const bridge = createCodexDynamicToolBridge({
      tools: [
        createTool({
          name: "computer",
          execute: vi.fn(async () => textToolResult("older result")),
        }),
      ],
      signal: new AbortController().signal,
      computerContextEpoch,
    });

    await bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "shot-older",
      namespace: null,
      tool: "computer",
      arguments: {},
    });

    expect(computerContextEpoch).toEqual({ value: 2, frameToolCallId: "shot-newer" });
  });

  it("preserves nested toolResult content after no-op middleware", async () => {
    const registry = createEmptyPluginRegistry();
    const handler = vi.fn(async () => undefined);
    registry.agentToolResultMiddlewares.push({
      pluginId: "tokenjuice",
      pluginName: "Tokenjuice",
      rawHandler: handler,
      handler,
      runtimes: ["codex"],
      source: "test",
    });
    setActivePluginRegistry(registry);

    const bridge = createBridgeWithToolResult("message", {
      content: [
        {
          type: "toolResult",
          toolUseId: "call-1",
          content: [{ type: "text", text: "message sent: msg_123" }],
        } as never,
      ],
      details: { messageId: "msg_123" },
    });

    const result = await bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      namespace: null,
      tool: "message",
      arguments: { text: "hello" },
    });

    expect(result).toEqual(expectInputText("message sent: msg_123"));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("passes raw tool failure state into agent tool result middleware", async () => {
    const registry = createEmptyPluginRegistry();
    const handler = vi.fn(async (_eventValue: { isError?: boolean }) => undefined);
    registry.agentToolResultMiddlewares.push({
      pluginId: "tokenjuice",
      pluginName: "Tokenjuice",
      rawHandler: handler,
      handler,
      runtimes: ["codex"],
      source: "test",
    });
    setActivePluginRegistry(registry);

    const bridge = createBridgeWithToolResult("exec", {
      content: [{ type: "text", text: "failed output" }],
      details: { status: "failed", exitCode: 1 },
    });

    const result = await bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      namespace: null,
      tool: "exec",
      arguments: { command: "false" },
    });

    expect(result).toEqual({
      success: false,
      contentItems: [{ type: "inputText", text: "failed output" }],
    });
    expect(result.sideEffectEvidence).toBe(true);
    const event = requireRecord(callArg(handler, 0, 0, "middleware event"), "middleware event");
    expect(event.isError).toBe(true);
    expectContextFields(callArg(handler, 0, 1, "middleware context"), { runtime: "codex" });
  });

  it("keeps unrecognized non-success statuses fail-closed", async () => {
    const onAgentToolResult = vi.fn();
    const bridge = createCodexDynamicToolBridge({
      tools: [
        createTool({
          name: "exec",
          execute: vi.fn(async () =>
            textToolResult("Approval is unavailable.", { status: "approval-unavailable" }),
          ),
        }),
      ],
      signal: new AbortController().signal,
    });

    const result = await bridge.handleToolCall(
      {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        namespace: null,
        tool: "exec",
        arguments: { command: "pwd" },
      },
      { onAgentToolResult },
    );

    expect(result).toMatchObject({ success: false });
    expect(onAgentToolResult).toHaveBeenCalledWith({
      toolName: "exec",
      result: textToolResult("Approval is unavailable.", { status: "approval-unavailable" }),
      isError: true,
    });
  });

  it("preserves explicitly successful cancellation outcomes", async () => {
    const onAgentToolResult = vi.fn();
    const cancelledResult = textToolResult("Approval rejected.", {
      ok: true,
      status: "cancelled",
    });
    const bridge = createCodexDynamicToolBridge({
      tools: [
        createTool({
          name: "lobster",
          execute: vi.fn(async () => cancelledResult),
        }),
      ],
      signal: new AbortController().signal,
    });

    const result = await bridge.handleToolCall(
      {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        namespace: null,
        tool: "lobster",
        arguments: {},
      },
      { onAgentToolResult },
    );

    expect(result).toMatchObject({ success: true });
    expect(onAgentToolResult).toHaveBeenCalledWith({
      toolName: "lobster",
      result: cancelledResult,
      isError: false,
    });
  });

  it("reports sanitized dynamic tool results to the private result observer", async () => {
    const onAgentToolResult = vi.fn();
    const bridge = createCodexDynamicToolBridge({
      tools: [
        createTool({
          name: "memory_lookup_custom",
          execute: vi.fn(async () =>
            textToolResult("OPENROUTER_API_KEY=sk-or-v1-abcdef0123456789", {
              status: "failed",
              error: "backend unavailable",
            }),
          ),
        }),
      ],
      signal: new AbortController().signal,
    });

    await bridge.handleToolCall(
      {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        namespace: null,
        tool: "memory_lookup_custom",
        arguments: {},
      },
      { onAgentToolResult },
    );

    expect(onAgentToolResult).toHaveBeenCalledOnce();
    expect(onAgentToolResult).toHaveBeenCalledWith({
      toolName: "memory_lookup_custom",
      result: {
        content: [{ type: "text", text: "OPENROUTER_API_KEY=sk-or-…6789" }],
        details: { status: "failed", error: "backend unavailable" },
      },
      isError: true,
    });
  });

  it("reports thrown dynamic tool failures to the private result observer", async () => {
    const onAgentToolResult = vi.fn();
    const bridge = createCodexDynamicToolBridge({
      tools: [
        createTool({
          name: "memory_lookup_custom",
          execute: vi.fn(async () => {
            throw new Error("backend unavailable");
          }),
        }),
      ],
      signal: new AbortController().signal,
    });

    await bridge.handleToolCall(
      {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        namespace: null,
        tool: "memory_lookup_custom",
        arguments: {},
      },
      { onAgentToolResult },
    );

    expect(onAgentToolResult).toHaveBeenCalledWith({
      toolName: "memory_lookup_custom",
      result: {
        content: [{ type: "text", text: "backend unavailable" }],
        details: { status: "failed", error: "backend unavailable" },
      },
      isError: true,
    });
  });

  it("keeps thrown read-only dynamic tool failures replay-safe", async () => {
    const bridge = createCodexDynamicToolBridge({
      tools: [
        createTool({
          name: "web_fetch",
          execute: vi.fn(async () => {
            throw new Error("backend unavailable");
          }),
        }),
      ],
      signal: new AbortController().signal,
    });

    const result = await bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      namespace: null,
      tool: "web_fetch",
      arguments: { url: "https://example.com" },
    });

    expect(result.success).toBe(false);
    expect(result.sideEffectEvidence).toBeUndefined();
  });

  it("preserves terminal async tool results without marking them as errors", async () => {
    const bridge = createBridgeWithToolResult("image_generate", {
      content: [{ type: "text", text: "Background task started." }],
      details: { async: true, status: "started", taskId: "task-1" },
      terminate: true,
    });

    const result = await bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      namespace: null,
      tool: "image_generate",
      arguments: { prompt: "lighthouse" },
    });

    expect(result).toEqual(expectInputText("Background task started."));
    expect(result.asyncStarted).toBe(true);
    expect(result.sideEffectEvidence).toBe(true);
    expect(result.terminate).toBe(true);
    expect(Object.keys(result)).not.toContain("asyncStarted");
    expect(Object.keys(result)).not.toContain("terminate");
  });

  it("marks executed dynamic tool results as side-effect evidence", async () => {
    const bridge = createBridgeWithToolResult("exec", textToolResult("done"));

    const result = await bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      namespace: null,
      tool: "exec",
      arguments: { command: "touch /tmp/openclaw-replay-test" },
    });

    expect(result).toEqual(expectInputText("done"));
    expect(result.sideEffectEvidence).toBe(true);
  });

  it("omits side-effect evidence for explicitly replay-safe terminal tools", async () => {
    const bridge = createBridgeWithToolResult("web_fetch", textToolResult("done"));

    const result = await bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      namespace: null,
      tool: "web_fetch",
      arguments: { url: "https://example.com/private" },
    });

    expect(result).toEqual(expectInputText("done"));
    expect(result.sideEffectEvidence).toBeUndefined();
  });

  it("shares replay-safe classification with OpenClaw for read-only dynamic tools", async () => {
    const bridge = createBridgeWithToolResult("web_search", textToolResult("done"));

    const result = await bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-web-search",
      namespace: null,
      tool: "web_search",
      arguments: { query: "current weather" },
    });

    expect(result.sideEffectEvidence).toBeUndefined();
  });

  it("keeps async-started read-only tools replay-unsafe", async () => {
    const bridge = createBridgeWithToolResult(
      "web_search",
      textToolResult("Background task started.", {
        async: true,
        status: "started",
        taskId: "task-1",
      }),
    );

    const result = await bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-async-search",
      namespace: null,
      tool: "web_search",
      arguments: { query: "scheduler" },
    });

    expect(result.asyncStarted).toBe(true);
    expect(result.sideEffectEvidence).toBe(true);
  });

  it("keeps terminal tools replay-unsafe when before_tool_call can rewrite arguments", async () => {
    const beforeToolCall = vi.fn(async () => ({ params: { action: "add" } }));
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: beforeToolCall }]),
    );
    const execute = vi.fn(async () => textToolResult("done"));
    const bridge = createCodexDynamicToolBridge({
      tools: [createTool({ name: "cron", execute })],
      signal: new AbortController().signal,
    });

    const result = await bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      namespace: null,
      tool: "cron",
      arguments: { action: "status" },
    });

    expect(execute).toHaveBeenCalledWith(
      "call-1",
      { action: "add" },
      expect.any(AbortSignal),
      undefined,
    );
    expect(result.sideEffectEvidence).toBe(true);
  });

  it("keeps executed mutations replay-unsafe when middleware rewrites the result as blocked", async () => {
    const registry = createEmptyPluginRegistry();
    const handler = vi.fn(async () => ({
      result: textToolResult("blocked by middleware", {
        status: "blocked",
        deniedReason: "plugin-before-tool-call",
      }),
    }));
    registry.agentToolResultMiddlewares.push({
      pluginId: "redactor",
      pluginName: "Redactor",
      rawHandler: handler,
      handler,
      runtimes: ["codex"],
      source: "test",
    });
    setActivePluginRegistry(registry);
    const execute = vi.fn(async () => textToolResult("added", { id: "job-1" }));
    const bridge = createCodexDynamicToolBridge({
      tools: [createTool({ name: "cron", execute })],
      signal: new AbortController().signal,
    });

    const result = await bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-cron-rewritten-blocked",
      namespace: null,
      tool: "cron",
      arguments: { action: "add", job: { name: "reminder" } },
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.diagnosticTerminalType).toBe("blocked");
    expect(result.sideEffectEvidence).toBe(true);
  });

  it("snapshots executed arguments before result middleware can mutate them", async () => {
    const registry = createEmptyPluginRegistry();
    const handler = vi.fn(
      async (event: { args: Record<string, unknown>; result: AgentToolResult<unknown> }) => {
        event.args.action = "status";
        return { result: event.result };
      },
    );
    registry.agentToolResultMiddlewares.push({
      pluginId: "mutator",
      pluginName: "Mutator",
      rawHandler: handler,
      handler,
      runtimes: ["codex"],
      source: "test",
    });
    setActivePluginRegistry(registry);
    const bridge = createBridgeWithToolResult("cron", textToolResult("added", { id: "job-1" }));

    const result = await bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-cron-mutable-args",
      namespace: null,
      tool: "cron",
      arguments: { action: "add", job: { name: "reminder" } },
    });

    expect(result.sideEffectEvidence).toBe(true);
    expect(bridge.telemetry.successfulCronAdds).toBe(1);
  });

  it("snapshots executed arguments before after_tool_call hooks can mutate them", async () => {
    const afterToolCall = vi.fn((event: unknown) => {
      const eventRecord = requireRecord(event, "after_tool_call event");
      const paramsRecord = requireRecord(eventRecord.params, "after_tool_call params");
      paramsRecord.action = "status";
    });
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "after_tool_call", handler: afterToolCall }]),
    );
    const bridge = createBridgeWithToolResult("cron", textToolResult("added", { id: "job-1" }));

    const result = await bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      namespace: null,
      tool: "cron",
      arguments: { action: "add", job: { name: "reminder" } },
    });

    expect(result.sideEffectEvidence).toBe(true);
    expect(bridge.telemetry.successfulCronAdds).toBe(1);
  });

  it("does not mark pre-execution argument failures as side-effect evidence", async () => {
    const execute = vi.fn(async () => textToolResult("should not run"));
    const onToolOutcome = vi.fn();
    const bridge = createCodexDynamicToolBridge({
      tools: [
        createTool({
          name: "exec",
          execute,
          ...({
            prepareArguments: () => {
              throw new Error("invalid arguments");
            },
          } as { prepareArguments: () => never }),
        }),
      ],
      signal: new AbortController().signal,
      hookContext: { runId: "run-invalid-arguments", onToolOutcome },
    });

    const result = await bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      namespace: null,
      tool: "exec",
      arguments: {},
    });

    expect(result).toEqual({
      success: false,
      contentItems: [{ type: "inputText", text: "invalid arguments" }],
    });
    expect(result.sideEffectEvidence).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
    expect(onToolOutcome).toHaveBeenLastCalledWith({
      toolName: "exec",
      argsHash: "",
      resultHash: "",
      terminalPresentation: undefined,
      presentationOnly: true,
    });
  });

  it("uses raw tool provenance for media trust after middleware rewrites details", async () => {
    const registry = createEmptyPluginRegistry();
    const handler = vi.fn(async (event: { result: AgentToolResult<unknown> }) => ({
      result: {
        ...event.result,
        content: [{ type: "text" as const, text: "Generated media reply." }],
        details: {
          media: {
            mediaUrl: "/tmp/unsafe.png",
          },
        },
      },
    }));
    registry.agentToolResultMiddlewares.push({
      pluginId: "tokenjuice",
      pluginName: "Tokenjuice",
      rawHandler: handler,
      handler,
      runtimes: ["codex"],
      source: "test",
    });
    setActivePluginRegistry(registry);

    const bridge = createBridgeWithToolResult("browser", {
      content: [{ type: "text", text: "raw output" }],
      details: {
        mcpServer: "external",
        mcpTool: "browser",
      },
    });

    const result = await bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      namespace: null,
      tool: "browser",
      arguments: {},
    });

    expect(result).toEqual(expectInputText("Generated media reply."));
    expect(bridge.telemetry.toolMediaUrls).toStrictEqual([]);
  });

  it("still applies legacy codex app-server extension factories after middleware", async () => {
    const registry = createEmptyPluginRegistry();
    const factory = async (codex: {
      on: (
        event: "tool_result",
        handler: (event: any) => Promise<{ result: AgentToolResult<unknown> }>,
      ) => void;
    }) => {
      codex.on("tool_result", async (event) => ({
        result: {
          ...event.result,
          content: [{ type: "text", text: "legacy compacted" }],
        },
      }));
    };
    registry.codexAppServerExtensionFactories.push({
      pluginId: "tokenjuice",
      pluginName: "Tokenjuice",
      rawFactory: factory,
      factory,
      source: "test",
    });
    setActivePluginRegistry(registry);

    const bridge = createBridgeWithToolResult("exec", {
      content: [{ type: "text", text: "raw output" }],
      details: {},
    });

    const result = await bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      namespace: null,
      tool: "exec",
      arguments: { command: "git status" },
    });

    expect(result).toEqual(expectInputText("legacy compacted"));
  });

  it("keeps config out of Codex tool-result contexts", async () => {
    const config = { session: { store: "/tmp/openclaw-session-store.json" } };
    const registry = createEmptyPluginRegistry();
    const middlewareContexts: Record<string, unknown>[] = [];
    const legacyContexts: Record<string, unknown>[] = [];
    const middleware = vi.fn(async (eventValue: unknown, ctx: Record<string, unknown>) => {
      middlewareContexts.push(ctx);
      return undefined;
    });
    const factory = async (codex: {
      on: (
        event: "tool_result",
        handler: (
          event: unknown,
          ctx: Record<string, unknown>,
        ) => Promise<{ result: AgentToolResult<unknown> } | void>,
      ) => void;
    }) => {
      codex.on("tool_result", async (eventValue, ctx) => {
        legacyContexts.push(ctx);
      });
    };
    registry.agentToolResultMiddlewares.push({
      pluginId: "tokenjuice",
      pluginName: "Tokenjuice",
      rawHandler: middleware,
      handler: middleware,
      runtimes: ["codex"],
      source: "test",
    });
    registry.codexAppServerExtensionFactories.push({
      pluginId: "legacy",
      pluginName: "Legacy",
      rawFactory: factory,
      factory,
      source: "test",
    });
    setActivePluginRegistry(registry);

    const execute = vi.fn(async () => textToolResult("done"));
    const bridge = createCodexDynamicToolBridge({
      tools: [createTool({ name: "exec", execute })],
      signal: new AbortController().signal,
      hookContext: {
        agentId: "agent-1",
        config: config as never,
        sessionId: "session-1",
        sessionKey: "agent:agent-1:session-1",
        runId: "run-1",
      },
    });

    await bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      namespace: null,
      tool: "exec",
      arguments: { command: "pwd" },
    });

    expectExecuteCall(execute, { callId: "call-1", args: { command: "pwd" } });
    expect(middlewareContexts).toHaveLength(1);
    expectContextFields(middlewareContexts[0], {
      runtime: "codex",
      agentId: "agent-1",
      sessionId: "session-1",
      sessionKey: "agent:agent-1:session-1",
      runId: "run-1",
    });
    expect(middlewareContexts[0]).not.toHaveProperty("config");
    expect(legacyContexts).toHaveLength(1);
    expectContextFields(legacyContexts[0], {
      agentId: "agent-1",
      sessionId: "session-1",
      sessionKey: "agent:agent-1:session-1",
      runId: "run-1",
    });
    expect(legacyContexts[0]).not.toHaveProperty("config");
  });

  it("fires after_tool_call for successful codex tool executions", async () => {
    const afterToolCall = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "after_tool_call", handler: afterToolCall }]),
    );

    const bridge = createBridgeWithToolResult(
      "exec",
      {
        content: [{ type: "text", text: "done" }],
        details: {},
      },
      {
        agentId: "agent-1",
        sessionId: "session-1",
        sessionKey: "agent:agent-1:session-1",
        runId: "run-1",
        channelId: "voice-room",
      },
    );

    await bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      namespace: null,
      tool: "exec",
      arguments: { command: "pwd" },
    });

    await vi.waitFor(() => {
      expect(afterToolCall).toHaveBeenCalledTimes(1);
    });
    const event = requireRecord(callArg(afterToolCall, 0, 0, "after_tool_call event"), "event");
    expect(event.toolName).toBe("exec");
    expect(event.toolCallId).toBe("call-1");
    expect(event.params).toEqual({ command: "pwd" });
    expectToolResult(event.result, {
      content: [{ type: "text", text: "done" }],
      details: {},
    });
    expectContextFields(callArg(afterToolCall, 0, 1, "after_tool_call context"), {
      agentId: "agent-1",
      sessionId: "session-1",
      sessionKey: "agent:agent-1:session-1",
      runId: "run-1",
      channelId: "voice-room",
      toolName: "exec",
      toolCallId: "call-1",
    });
  });

  it("runs before_tool_call for unwrapped dynamic tools before execution", async () => {
    const beforeToolCall = vi.fn(async () => ({ params: { mode: "safe" } }));
    const afterToolCall = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "before_tool_call", handler: beforeToolCall },
        { hookName: "after_tool_call", handler: afterToolCall },
      ]),
    );

    const execute = vi.fn(async () => textToolResult("done", { ok: true }));
    const bridge = createCodexDynamicToolBridge({
      tools: [createTool({ name: "exec", execute })],
      signal: new AbortController().signal,
      hookContext: {
        agentId: "agent-1",
        sessionId: "session-1",
        sessionKey: "agent:agent-1:session-1",
        runId: "run-1",
      },
    });

    const result = await bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      namespace: null,
      tool: "exec",
      arguments: { command: "pwd" },
    });

    expect(result).toEqual(expectInputText("done"));
    const beforeEvent = requireRecord(
      callArg(beforeToolCall, 0, 0, "before_tool_call event"),
      "before event",
    );
    expect(beforeEvent.toolName).toBe("exec");
    expect(beforeEvent.toolCallId).toBe("call-1");
    expect(beforeEvent.runId).toBe("run-1");
    expect(beforeEvent.params).toEqual({ command: "pwd" });
    expectContextFields(callArg(beforeToolCall, 0, 1, "before_tool_call context"), {
      agentId: "agent-1",
      sessionId: "session-1",
      sessionKey: "agent:agent-1:session-1",
      runId: "run-1",
      toolCallId: "call-1",
    });
    expectExecuteCall(execute, { callId: "call-1", args: { command: "pwd", mode: "safe" } });
    await vi.waitFor(() => {
      expect(afterToolCall).toHaveBeenCalledTimes(1);
    });
    const afterEvent = requireRecord(
      callArg(afterToolCall, 0, 0, "after_tool_call event"),
      "after event",
    );
    expect(afterEvent.toolName).toBe("exec");
    expect(afterEvent.toolCallId).toBe("call-1");
    expect(afterEvent.params).toEqual({ command: "pwd", mode: "safe" });
    expectToolResult(afterEvent.result, {
      content: [{ type: "text", text: "done" }],
      details: { ok: true },
    });
    expectContextFields(callArg(afterToolCall, 0, 1, "after_tool_call context"), {
      agentId: "agent-1",
      sessionId: "session-1",
      sessionKey: "agent:agent-1:session-1",
      runId: "run-1",
      toolCallId: "call-1",
    });
  });

  it("does not execute dynamic tools blocked by before_tool_call", async () => {
    const beforeToolCall = vi.fn(async () => ({
      block: true,
      blockReason: "blocked by policy",
    }));
    const afterToolCall = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "before_tool_call", handler: beforeToolCall },
        { hookName: "after_tool_call", handler: afterToolCall },
      ]),
    );
    const execute = vi.fn(async () => textToolResult("should not run"));
    const bridge = createCodexDynamicToolBridge({
      tools: [createTool({ name: "message", execute })],
      signal: new AbortController().signal,
      hookContext: { runId: "run-blocked" },
    });

    const result = await handleMessageToolCall(bridge, {
      action: "send",
      text: "blocked",
      provider: "telegram",
      to: "chat-1",
    });

    expect(result).toEqual({
      success: false,
      contentItems: [{ type: "inputText", text: "blocked by policy" }],
    });
    expect(result.sideEffectEvidence).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
    expect(bridge.telemetry.didSendViaMessagingTool).toBe(false);
    await vi.waitFor(() => {
      expect(afterToolCall).toHaveBeenCalledTimes(1);
    });
    const event = requireRecord(callArg(afterToolCall, 0, 0, "after_tool_call event"), "event");
    expect(event.toolName).toBe("message");
    expect(event.toolCallId).toBe("call-1");
    expect(event.params).toEqual({
      action: "send",
      text: "blocked",
      provider: "telegram",
      to: "chat-1",
    });
    expectToolResult(event.result, {
      content: [{ type: "text", text: "blocked by policy" }],
      details: {
        status: "blocked",
        deniedReason: "plugin-before-tool-call",
        reason: "blocked by policy",
      },
    });
    expectContextFields(callArg(afterToolCall, 0, 1, "after_tool_call context"), {
      runId: "run-blocked",
      toolCallId: "call-1",
    });
  });

  it("preserves hook timeout classification for the outer lifecycle owner", async () => {
    const beforeToolCall = vi.fn(async () => {
      throw Object.assign(new Error("timed out after 5ms"), { name: "TimeoutError" });
    });
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: beforeToolCall }]),
    );
    const execute = vi.fn(async () => textToolResult("should not run"));
    const bridge = createCodexDynamicToolBridge({
      tools: [createTool({ name: "exec", execute })],
      signal: new AbortController().signal,
      hookContext: { runId: "run-hook-timeout" },
    });

    const result = await bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-hook-timeout",
      namespace: null,
      tool: "exec",
      arguments: { command: "pwd" },
    });

    expect(result.success).toBe(false);
    expect(result.diagnosticTerminalType).toBe("error");
    expect(result.diagnosticTerminalReason).toBe("timed_out");
    expect(result.sideEffectEvidence).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(["timed_out", "cancelled"] as const)(
    "preserves structured %s results for the outer lifecycle owner",
    async (status) => {
      const bridge = createBridgeWithToolResult("exec", textToolResult("tool stopped", { status }));

      const result = await bridge.handleToolCall({
        threadId: "thread-1",
        turnId: "turn-1",
        callId: `call-${status}`,
        namespace: null,
        tool: "exec",
        arguments: { command: "pwd" },
      });

      expect(result.success).toBe(false);
      expect(result.diagnosticTerminalType).toBe("error");
      expect(result.diagnosticTerminalReason).toBe(status);
    },
  );

  it("preserves thrown timeout classification for the outer lifecycle owner", async () => {
    const timeoutError = Object.assign(new Error("tool deadline elapsed"), {
      name: "TimeoutError",
    });
    const onAgentToolResult = vi.fn();
    const bridge = createCodexDynamicToolBridge({
      tools: [
        createTool({
          name: "exec",
          execute: vi.fn(async () => {
            throw timeoutError;
          }),
        }),
      ],
      signal: new AbortController().signal,
    });

    const result = await bridge.handleToolCall(
      {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-timeout",
        namespace: null,
        tool: "exec",
        arguments: { command: "pwd" },
      },
      { onAgentToolResult },
    );

    expect(result.success).toBe(false);
    expect(result.diagnosticTerminalType).toBe("error");
    expect(result.diagnosticTerminalReason).toBe("timed_out");
    expect(onAgentToolResult).toHaveBeenCalledWith({
      toolName: "exec",
      result: {
        content: [{ type: "text", text: "tool deadline elapsed" }],
        details: { status: "timed_out", error: "tool deadline elapsed" },
      },
      isError: true,
    });
  });

  it("contains hostile thrown values while notifying the outer lifecycle owner", async () => {
    const hostileError = Object.defineProperty(new Error(), "message", {
      get() {
        throw new Error("message getter escaped");
      },
    });
    const onAgentToolResult = vi.fn();
    const bridge = createCodexDynamicToolBridge({
      tools: [
        createTool({
          name: "exec",
          execute: vi.fn(async () => {
            throw hostileError;
          }),
        }),
      ],
      signal: new AbortController().signal,
    });

    const result = await bridge.handleToolCall(
      {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-hostile-error",
        namespace: null,
        tool: "exec",
        arguments: { command: "pwd" },
      },
      { onAgentToolResult },
    );

    expect(result).toMatchObject({
      success: false,
      diagnosticTerminalReason: "failed",
      contentItems: [{ type: "inputText", text: "OpenClaw dynamic tool call failed." }],
    });
    expect(onAgentToolResult).toHaveBeenCalledOnce();
  });

  it("preserves report-only approval blocks for the outer lifecycle owner", async () => {
    const beforeToolCall = vi.fn(async () => ({
      requireApproval: {
        pluginId: "test-plugin",
        title: "Needs approval",
        description: "Review before running",
      },
    }));
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: beforeToolCall }]),
    );
    const execute = vi.fn(async () => textToolResult("should not run"));
    const tool = wrapToolWithBeforeToolCallHook(
      createTool({ name: "exec", execute }),
      { runId: "run-approval-report" },
      { approvalMode: "report" },
    );
    const bridge = createCodexDynamicToolBridge({
      tools: [tool],
      signal: new AbortController().signal,
      hookContext: { runId: "run-approval-report" },
    });

    const result = await bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-approval-report",
      namespace: null,
      tool: "exec",
      arguments: { command: "pwd" },
    });

    expect(result.success).toBe(false);
    expect(result.diagnosticTerminalType).toBe("blocked");
    expect(result.diagnosticTerminalReason).toBeUndefined();
    expect(result.sideEffectEvidence).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
  });

  it("applies dynamic tool result middleware before after_tool_call observes the result", async () => {
    const events: string[] = [];
    const beforeToolCall = vi.fn(async () => {
      events.push("before_tool_call");
      return { params: { mode: "safe" } };
    });
    const afterToolCall = vi.fn(async (event) => {
      events.push("after_tool_call");
      const record = requireRecord(event, "after_tool_call event");
      expect(record.params).toEqual({ command: "status", mode: "safe" });
      expectToolResult(record.result, {
        content: [{ type: "text", text: "compacted output" }],
        details: { stage: "middleware" },
      });
    });
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "before_tool_call", handler: beforeToolCall },
        { hookName: "after_tool_call", handler: afterToolCall },
      ]),
    );
    const registry = createEmptyPluginRegistry();
    const handler = vi.fn(
      async (event: { args: Record<string, unknown>; result: AgentToolResult<unknown> }) => {
        events.push("middleware");
        expect(event.args).toEqual({ command: "status", mode: "safe" });
        return {
          result: {
            ...event.result,
            content: [{ type: "text" as const, text: "compacted output" }],
            details: { stage: "middleware" },
          },
        };
      },
    );
    registry.agentToolResultMiddlewares.push({
      pluginId: "tokenjuice",
      pluginName: "Tokenjuice",
      rawHandler: handler,
      handler,
      runtimes: ["codex"],
      source: "test",
    });
    setActivePluginRegistry(registry);
    const execute = vi.fn(async () => {
      events.push("execute");
      return textToolResult("raw output", { stage: "execute" });
    });
    const bridge = createCodexDynamicToolBridge({
      tools: [createTool({ name: "exec", execute })],
      signal: new AbortController().signal,
      hookContext: { runId: "run-middleware" },
    });

    const result = await bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      namespace: null,
      tool: "exec",
      arguments: { command: "status" },
    });

    expect(result).toEqual(expectInputText("compacted output"));
    await vi.waitFor(() => {
      expect(events).toEqual(["before_tool_call", "execute", "middleware", "after_tool_call"]);
    });
  });

  it.each(["timed_out", "cancelled", "blocked"] as const)(
    "preserves raw %s disposition for private observation after middleware rewrites it",
    async (status) => {
      const registry = createEmptyPluginRegistry();
      const handler = vi.fn(async (event: { result: AgentToolResult<unknown> }) => {
        event.result.content = [{ type: "text", text: "compacted failure" }];
        const details = requireRecord(event.result.details, "middleware details");
        details.stage = "middleware";
        details.status = "failed";
        return { result: event.result };
      });
      registry.agentToolResultMiddlewares.push({
        pluginId: "result-redactor",
        pluginName: "Result Redactor",
        rawHandler: handler,
        handler,
        runtimes: ["codex"],
        source: "test",
      });
      setActivePluginRegistry(registry);
      const onAgentToolResult = vi.fn();
      const bridge = createBridgeWithToolResult("exec", textToolResult("raw failure", { status }));

      const result = await bridge.handleToolCall(
        {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: `call-raw-${status}`,
          namespace: null,
          tool: "exec",
          arguments: { command: "status" },
        },
        { onAgentToolResult },
      );

      expect(result.success).toBe(false);
      expect(result.diagnosticTerminalType).toBe(status === "blocked" ? "blocked" : "error");
      expect(result.diagnosticTerminalReason).toBe(status === "blocked" ? undefined : status);
      expect(onAgentToolResult).toHaveBeenCalledWith({
        toolName: "exec",
        result: {
          content: [{ type: "text", text: "compacted failure" }],
          details: { stage: "middleware", status },
        },
        isError: true,
      });
    },
  );

  it("reports confirmed sends as successful when result middleware fails", async () => {
    const registry = createEmptyPluginRegistry();
    const handler = vi.fn((event: { result: AgentToolResult<unknown> }) => {
      const details = requireRecord(event.result.details, "message details");
      const providerResult = requireRecord(details.result, "provider result");
      delete providerResult.messageId;
      throw new Error("redaction failed");
    });
    registry.agentToolResultMiddlewares.push({
      pluginId: "broken-redactor",
      pluginName: "Broken redactor",
      rawHandler: handler,
      handler,
      runtimes: ["codex"],
      source: "test",
    });
    setActivePluginRegistry(registry);
    const bridge = createBridgeWithToolResult(
      "message",
      textToolResult("raw result must stay private", {
        ok: true,
        result: {
          messageId: "1700000000.000100",
          channelId: "C123",
          threadId: "1700000000.000000",
        },
      }),
    );

    const result = await handleMessageToolCall(bridge, {
      action: "send",
      target: "C123",
      text: "hello",
    });

    expect(result).toEqual(
      expectInputText("Message delivered, but result post-processing failed."),
    );
    expect(result.sideEffectEvidence).toBe(true);
  });

  it("keeps deferred internal source replies closed when result middleware fails", async () => {
    const registry = createEmptyPluginRegistry();
    const handler = vi.fn((event: { result: AgentToolResult<unknown> }) => {
      const details = requireRecord(event.result.details, "message details");
      details.messageId = "forged-by-middleware";
      throw new Error("redaction failed");
    });
    registry.agentToolResultMiddlewares.push({
      pluginId: "broken-redactor",
      pluginName: "Broken redactor",
      rawHandler: handler,
      handler,
      runtimes: ["codex"],
      source: "test",
    });
    setActivePluginRegistry(registry);
    const bridge = createBridgeWithToolResult(
      "message",
      textToolResult("queued for internal delivery", {
        status: "ok",
        deliveryStatus: "sent",
        sourceReplySink: "internal-ui",
        sourceReply: { text: "visible reply" },
      }),
    );

    const result = await handleMessageToolCall(bridge, {
      action: "send",
      target: "C123",
      text: "hello",
    });

    expect(result).toEqual({
      success: false,
      contentItems: [
        { type: "inputText", text: "Tool output unavailable due to post-processing error." },
      ],
    });
    expect(result.sideEffectEvidence).toBe(true);
  });

  it("builds terminal presentation from the post-middleware result", async () => {
    const registry = createEmptyPluginRegistry();
    const handler = vi.fn(async () => ({
      result: textToolResult("redacted output", {
        origin: "redacted.example",
        status: 200,
      }),
    }));
    registry.agentToolResultMiddlewares.push({
      pluginId: "redactor",
      pluginName: "Redactor",
      rawHandler: handler,
      handler,
      runtimes: ["codex"],
      source: "test",
    });
    setActivePluginRegistry(registry);
    const onToolOutcome = vi.fn();
    const tool = createTerminalPresentationContractTool({
      name: "web_fetch",
      result: textToolResult("raw output", {
        origin: "private.example",
        status: 200,
      }),
      format: (_params, result) => {
        const details = requireRecord(result.details, "terminal presentation details");
        return `Origin: ${String(details.origin)}\nStatus: ${String(details.status)}`;
      },
    });
    const bridge = createCodexDynamicToolBridge({
      tools: [tool],
      signal: new AbortController().signal,
      hookContext: {
        runId: "run-terminal-middleware",
        sessionId: "session-terminal-middleware",
        onToolOutcome,
      },
    });

    await bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-terminal-middleware",
      namespace: null,
      tool: "web_fetch",
      arguments: { url: "https://private.example" },
    });

    expect(onToolOutcome).toHaveBeenLastCalledWith(
      expect.objectContaining({
        presentationOnly: true,
        terminalPresentation: "Origin: redacted.example\nStatus: 200",
      }),
    );
  });

  it("clears raw terminal presentation when middleware returns an error", async () => {
    const registry = createEmptyPluginRegistry();
    const handler = vi.fn(async () => ({
      result: textToolResult("output blocked by middleware", {
        status: "error",
        middlewareError: true,
      }),
    }));
    registry.agentToolResultMiddlewares.push({
      pluginId: "redactor",
      pluginName: "Redactor",
      rawHandler: handler,
      handler,
      runtimes: ["codex"],
      source: "test",
    });
    setActivePluginRegistry(registry);
    const onToolOutcome = vi.fn();
    const tool = createTerminalPresentationContractTool({
      name: "web_fetch",
      result: textToolResult("raw output", {
        origin: "private.example",
        status: 200,
      }),
      format: (_params, result) => {
        const details = requireRecord(result.details, "terminal presentation details");
        return `Origin: ${String(details.origin)}`;
      },
    });
    const bridge = createCodexDynamicToolBridge({
      tools: [tool],
      signal: new AbortController().signal,
      hookContext: {
        runId: "run-terminal-middleware-error",
        sessionId: "session-terminal-middleware-error",
        onToolOutcome,
      },
    });

    await bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-terminal-middleware-error",
      namespace: null,
      tool: "web_fetch",
      arguments: { url: "https://private.example" },
    });

    expect(onToolOutcome).toHaveBeenLastCalledWith(
      expect.objectContaining({
        presentationOnly: true,
        terminalPresentation: undefined,
      }),
    );
  });

  it("reports dynamic tool execution errors through after_tool_call without stranding the turn", async () => {
    const beforeToolCall = vi.fn(async () => ({ params: { timeoutSec: 1 } }));
    const afterToolCall = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "before_tool_call", handler: beforeToolCall },
        { hookName: "after_tool_call", handler: afterToolCall },
      ]),
    );
    const execute = vi.fn(async () => {
      throw new Error("tool failed");
    });
    const bridge = createCodexDynamicToolBridge({
      tools: [createTool({ name: "exec", execute })],
      signal: new AbortController().signal,
      hookContext: { runId: "run-error" },
    });

    const result = await bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-err",
      namespace: null,
      tool: "exec",
      arguments: { command: "false" },
    });

    expect(result).toEqual({
      success: false,
      contentItems: [{ type: "inputText", text: "tool failed" }],
    });
    expectExecuteCall(execute, {
      callId: "call-err",
      args: { command: "false", timeoutSec: 1 },
    });
    await vi.waitFor(() => {
      expect(afterToolCall).toHaveBeenCalledTimes(1);
    });
    const event = requireRecord(callArg(afterToolCall, 0, 0, "after_tool_call event"), "event");
    expect(event.toolName).toBe("exec");
    expect(event.toolCallId).toBe("call-err");
    expect(event.params).toEqual({ command: "false", timeoutSec: 1 });
    expect(event.error).toBe("tool failed");
    expectContextFields(callArg(afterToolCall, 0, 1, "after_tool_call context"), {
      runId: "run-error",
      toolCallId: "call-err",
    });
  });

  it("passes per-call abort signals into dynamic tool execution", async () => {
    let capturedSignal: AbortSignal | undefined;
    let resolveTool: ((result: AgentToolResult<unknown>) => void) | undefined;
    const execute = vi.fn(
      async (_callId: string, _args: Record<string, unknown>, signal: AbortSignal) =>
        await new Promise<AgentToolResult<unknown>>((resolve) => {
          capturedSignal = signal;
          resolveTool = resolve;
        }),
    );
    const runController = new AbortController();
    const callController = new AbortController();
    const bridge = createCodexDynamicToolBridge({
      tools: [createTool({ name: "exec", execute })],
      signal: runController.signal,
    });

    const result = bridge.handleToolCall(
      {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-signal",
        namespace: null,
        tool: "exec",
        arguments: { command: "sleep" },
      },
      { signal: callController.signal },
    );
    await vi.waitFor(() => {
      if (!capturedSignal) {
        throw new Error("expected dynamic tool call signal");
      }
    });
    if (!capturedSignal) {
      throw new Error("expected dynamic tool call signal");
    }

    callController.abort(new Error("deadline"));
    expect(capturedSignal.aborted).toBe(true);
    resolveTool?.(textToolResult("done"));

    await expect(result).resolves.toEqual(expectInputText("done"));
  });

  it("does not double-wrap dynamic tools that already have before_tool_call", async () => {
    const beforeToolCall = vi.fn(async () => ({ params: { mode: "safe" } }));
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: beforeToolCall }]),
    );
    const execute = vi.fn(async () => textToolResult("done"));
    const tool = wrapToolWithBeforeToolCallHook(createTool({ name: "exec", execute }), {
      runId: "run-wrapped",
    });
    const bridge = createCodexDynamicToolBridge({
      tools: [tool],
      signal: new AbortController().signal,
      hookContext: { runId: "run-wrapped" },
    });

    await bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-wrapped",
      namespace: null,
      tool: "exec",
      arguments: { command: "pwd" },
    });

    expect(beforeToolCall).toHaveBeenCalledTimes(1);
    expectExecuteCall(execute, {
      callId: "call-wrapped",
      args: { command: "pwd", mode: "safe" },
    });
  });
});
