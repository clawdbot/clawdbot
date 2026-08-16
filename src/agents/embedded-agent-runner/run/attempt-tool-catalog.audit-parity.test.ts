/**
 * Regression test for issue #119253: bundle MCP/LSP tools reach the embedded
 * attempt catalog boundary without the before_tool_call wrapper that owns the
 * trusted audit lifecycle, so their executions emit no `tool.execution.started`
 * event and leave no `tool_action` audit records (the audit projection turns
 * `tool.execution.started` into `tool.action.started` ledger rows).
 *
 * The catalog boundary now wraps unwrapped tools with that wrapper; the adapter
 * (`toToolDefinitions`) skips its own `before_tool_call` invocation for wrapped
 * tools, so plugin hooks still fire exactly once via this wrapper while the
 * missing audit event is restored.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "../../../infra/diagnostic-events.js";
import { setPluginToolMeta } from "../../../plugins/tools.js";
import { toToolDefinitions } from "../../agent-tool-definition-adapter.js";
import {
  isToolWrappedWithBeforeToolCallHook,
  wrapToolWithBeforeToolCallHook,
} from "../../agent-tools.before-tool-call.js";
import type { AnyAgentTool } from "../../tools/common.js";

const RUN_ID = "audit-parity-run";

/** A bundle-MCP-shaped tool that reaches the catalog boundary unwrapped. */
function createBundleMcpTool(name = "fixture__echo_constant"): AnyAgentTool {
  const tool = {
    name,
    label: name,
    description: "bundle MCP fixture tool",
    parameters: { type: "object" as const, properties: {}, additionalProperties: false },
    execute: async () => ({
      content: [{ type: "text" as const, text: "AUDIT-FIXTURE-8F3A" }],
      details: { status: "ok" },
    }),
  } as unknown as AnyAgentTool;
  setPluginToolMeta(tool, { pluginId: "bundle-mcp", optional: false });
  return tool;
}

function createHookContext() {
  // Minimal context: runId drives the audit event correlation; sessionKey is
  // intentionally absent so loop detection is skipped without a registry.
  return { runId: RUN_ID, agentId: "agent" };
}

function captureToolExecutionEvents(): { events: DiagnosticEventPayload[]; stop: () => void } {
  const events: DiagnosticEventPayload[] = [];
  const stop = onInternalDiagnosticEvent((event) => {
    if (event.type.startsWith("tool.execution.")) {
      events.push(event);
    }
  });
  return { events, stop };
}

async function executeViaAdapter(tool: AnyAgentTool): Promise<void> {
  const definition = toToolDefinitions([tool], createHookContext())[0];
  if (!definition) {
    throw new Error("missing tool definition");
  }
  const extensionContext = {} as Parameters<typeof definition.execute>[4];
  await definition.execute("call-1", {}, undefined, undefined, extensionContext);
  // Trusted diagnostic events are emitted synchronously, but the shared bus
  // flush is guaranteed on the next macrotask.
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

describe("issue #119253 audit parity at the tool catalog boundary", () => {
  beforeEach(() => {
    resetDiagnosticEventsForTest();
  });
  afterEach(() => {
    resetDiagnosticEventsForTest();
  });

  it("an unwrapped bundle-MCP tool emits no tool.execution.started audit event", async () => {
    const tool = createBundleMcpTool();
    const { events, stop } = captureToolExecutionEvents();
    try {
      await executeViaAdapter(tool);
    } finally {
      stop();
    }
    expect(events.filter((event) => event.type === "tool.execution.started")).toHaveLength(0);
  });

  it("a tool wrapped with the before_tool_call wrapper emits the tool.execution.started audit event", async () => {
    const tool = wrapToolWithBeforeToolCallHook(createBundleMcpTool(), createHookContext());
    const { events, stop } = captureToolExecutionEvents();
    try {
      await executeViaAdapter(tool);
    } finally {
      stop();
    }
    const started = events.filter((event) => event.type === "tool.execution.started");
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({
      type: "tool.execution.started",
      toolName: "fixture__echo_constant",
      runId: RUN_ID,
    });
  });

  it("emits a terminal tool.execution.completed audit event for a wrapped tool", async () => {
    const tool = wrapToolWithBeforeToolCallHook(createBundleMcpTool(), createHookContext());
    const { events, stop } = captureToolExecutionEvents();
    try {
      await executeViaAdapter(tool);
    } finally {
      stop();
    }
    expect(events.filter((event) => event.type === "tool.execution.completed")).toHaveLength(1);
  });

  it("the catalog boundary wraps an unwrapped bundle-MCP tool (audit-lifecycle parity)", async () => {
    const { prepareEmbeddedAttemptToolCatalog } = await import("./attempt-tool-catalog.js");
    const unwrapped = createBundleMcpTool();
    expect(isToolWrappedWithBeforeToolCallHook(unwrapped)).toBe(false);

    const catalogInput = {
      attempt: {
        config: {},
        provider: "provider",
        model: { api: "responses" },
        modelId: "model",
        runId: RUN_ID,
        sessionId: "session",
        sessionKey: "session",
        runtimePlan: { tools: { logDiagnostics: () => {} } },
        currentChannelId: undefined,
      },
      preparedToolBase: {
        codeModeControlsEnabledForRun: false,
        codeModeSkills: [],
        localModelLeanPreserveToolNames: [],
        runtimeCapabilityProfile: { policy: { trustedGroup: { dropped: false } } },
        toolSearchConfig: { enabled: false, mode: "directory" },
        toolSearchControlsEnabledForRun: false,
        toolSearchRuntimeConfig: {},
        toolSearchCatalogRef: { current: undefined },
        toolsEnabled: true,
        effectiveToolsAllow: undefined,
        forceDirectMessageTool: false,
      },
      bundleTools: { clientTools: undefined, uncompactedEffectiveTools: [unwrapped] },
      effectiveCwd: "/tmp",
      effectiveWorkspace: "/tmp",
      sessionAgentId: "agent",
      sandboxSessionKey: "session",
      runTrace: undefined,
      abortSignal: undefined,
      executeCodeModeTool: vi.fn(),
      getProviderRuntimeHandle: () => ({}) as never,
      markStage: vi.fn(),
    } as unknown as Parameters<typeof prepareEmbeddedAttemptToolCatalog>[0];

    const result = prepareEmbeddedAttemptToolCatalog(catalogInput);
    expect(result.effectiveTools.length).toBeGreaterThan(0);
    const wrappedTool = result.effectiveTools[0];
    if (!wrappedTool) {
      throw new Error("catalog boundary produced no effective tools");
    }
    expect(isToolWrappedWithBeforeToolCallHook(wrappedTool)).toBe(true);
  });

  it("the catalog boundary preserves an already-wrapped core tool", async () => {
    const { prepareEmbeddedAttemptToolCatalog } = await import("./attempt-tool-catalog.js");
    const coreTool = wrapToolWithBeforeToolCallHook(
      createBundleMcpTool("core__read"),
      createHookContext(),
    );
    const catalogInput = {
      attempt: {
        config: {},
        provider: "provider",
        model: { api: "responses" },
        modelId: "model",
        runId: RUN_ID,
        sessionId: "session",
        sessionKey: "session",
        runtimePlan: { tools: { logDiagnostics: () => {} } },
      },
      preparedToolBase: {
        codeModeControlsEnabledForRun: false,
        codeModeSkills: [],
        localModelLeanPreserveToolNames: [],
        runtimeCapabilityProfile: { policy: { trustedGroup: { dropped: false } } },
        toolSearchConfig: { enabled: false, mode: "directory" },
        toolSearchControlsEnabledForRun: false,
        toolSearchRuntimeConfig: {},
        toolSearchCatalogRef: { current: undefined },
        toolsEnabled: true,
        effectiveToolsAllow: undefined,
        forceDirectMessageTool: false,
      },
      bundleTools: { clientTools: undefined, uncompactedEffectiveTools: [coreTool] },
      effectiveCwd: "/tmp",
      effectiveWorkspace: "/tmp",
      sessionAgentId: "agent",
      sandboxSessionKey: "session",
      runTrace: undefined,
      abortSignal: undefined,
      executeCodeModeTool: vi.fn(),
      getProviderRuntimeHandle: () => ({}) as never,
      markStage: vi.fn(),
    } as unknown as Parameters<typeof prepareEmbeddedAttemptToolCatalog>[0];

    const result = prepareEmbeddedAttemptToolCatalog(catalogInput);
    const wrappedTool = result.effectiveTools[0];
    if (!wrappedTool) {
      throw new Error("catalog boundary produced no effective tools");
    }
    expect(isToolWrappedWithBeforeToolCallHook(wrappedTool)).toBe(true);
  });
});
