import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentEventAuditRecorder } from "../../../audit/agent-event-audit.js";
import type { AuditEventInput } from "../../../audit/audit-event-types.js";
import type { AuditEventWriter } from "../../../audit/audit-event-writer.js";
import { onTrustedToolExecutionEvent } from "../../../infra/diagnostic-events.js";
import { setPluginToolMeta } from "../../../plugins/tools.js";
import { materializeBundleMcpToolsForRun } from "../../agent-bundle-mcp-tools.js";
import type { SessionMcpRuntime } from "../../agent-bundle-mcp-types.js";
import { wrapToolWithBeforeToolCallHook } from "../../agent-tools.before-tool-call.js";
import {
  BEFORE_TOOL_CALL_HOOK_CONTEXT,
  BEFORE_TOOL_CALL_SOURCE_TOOL,
  isToolWrappedWithBeforeToolCallHook,
} from "../../before-tool-call-metadata.js";
import { createStubTool } from "../../test-helpers/agent-tool-stubs.js";
import { resolveToolSearchConfig } from "../../tool-search.js";
import type { AnyAgentTool } from "../../tools/common.js";
import { prepareEmbeddedAttemptToolCatalog } from "./attempt-tool-catalog.js";
import { clearToolActivityRun } from "./tool-activity-heartbeat.js";

const RUN_ID = "run-attempt-tool-catalog";

function captureAuditWriter(inputs: AuditEventInput[]): AuditEventWriter {
  return {
    ready: Promise.resolve(),
    record: (input) => {
      inputs.push(input);
      return true;
    },
    stop: async () => {},
  };
}

function createSessionMcpRuntime(resultText = "FROM-BUNDLE") {
  const callTool = vi.fn(async () => ({
    content: [{ type: "text" as const, text: resultText }],
    isError: false,
  }));
  const catalog = {
    version: 1,
    generatedAt: 0,
    servers: {
      demo: {
        serverName: "demo",
        launchSummary: "demo",
        toolCount: 1,
        supportsParallelToolCalls: false,
      },
    },
    tools: [
      {
        serverName: "demo",
        safeServerName: "demo",
        toolName: "read",
        description: "Read from the fixture server",
        fallbackDescription: "Read from the fixture server",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  } satisfies Awaited<ReturnType<SessionMcpRuntime["getCatalog"]>>;
  const runtime: SessionMcpRuntime = {
    sessionId: "session-id",
    workspaceDir: "/workspace",
    configFingerprint: "fixture",
    createdAt: 0,
    lastUsedAt: 0,
    getCatalog: async () => catalog,
    peekCatalog: () => catalog,
    markUsed: vi.fn(),
    callTool,
    dispose: async () => {},
  };
  return { callTool, runtime };
}

function prepareCatalog(tools: AnyAgentTool[]) {
  const config = { tools: { toolSearch: false } } as const;
  return prepareEmbeddedAttemptToolCatalog({
    attempt: {
      config,
      model: { api: "openai-responses" },
      modelId: "test-model",
      provider: "test-provider",
      runId: RUN_ID,
      runtimePlan: { tools: { logDiagnostics: vi.fn() } },
      sessionId: "session-id",
      sessionKey: "agent:main:main",
    },
    preparedToolBase: {
      codeModeControlsEnabledForRun: false,
      codeModeSkills: [],
      forceDirectMessageTool: false,
      localModelLeanPreserveToolNames: [],
      runtimeCapabilityProfile: { policy: {} },
      toolSearchCatalogRef: undefined,
      toolSearchConfig: resolveToolSearchConfig(config),
      toolSearchControlsEnabledForRun: false,
      toolSearchRuntimeConfig: config,
      toolsEnabled: true,
    },
    bundleTools: {
      clientTools: undefined,
      uncompactedEffectiveTools: tools,
    },
    effectiveCwd: "/workspace",
    effectiveWorkspace: "/workspace",
    sessionAgentId: "main",
    sandboxSessionKey: "agent:main:main",
    runTrace: undefined,
    abortSignal: new AbortController().signal,
    executeCodeModeTool: async () => ({ content: [], details: {} }),
    getProviderRuntimeHandle: () => undefined,
    markStage: vi.fn(),
  } as unknown as Parameters<typeof prepareEmbeddedAttemptToolCatalog>[0]);
}

describe("prepareEmbeddedAttemptToolCatalog", () => {
  afterEach(() => {
    clearToolActivityRun(RUN_ID);
  });

  it("wraps direct late-added tools exactly once at the final catalog boundary", async () => {
    const originalContext = { runId: "core-run" };
    const coreSource = createStubTool("read");
    const coreTool = wrapToolWithBeforeToolCallHook(coreSource, originalContext);
    const materializedMcp = await materializeBundleMcpToolsForRun({
      runtime: createSessionMcpRuntime().runtime,
    });
    const mcpTool = materializedMcp.tools[0];
    if (!mcpTool) {
      throw new Error("expected one materialized MCP tool");
    }
    const lspTool = createStubTool("lsp_hover_typescript");
    setPluginToolMeta(lspTool, { pluginId: "bundle-lsp", optional: false });

    const result = prepareCatalog([coreTool, mcpTool, lspTool]);
    const [preparedCore, preparedMcp, preparedLsp] = result.effectiveTools;

    expect(result.toolSearch.compacted).toBe(false);
    expect(result.toolSearch.catalogRegistered).toBe(false);
    expect(result.effectiveTools).toHaveLength(3);
    expect(result.effectiveTools.every(isToolWrappedWithBeforeToolCallHook)).toBe(true);
    expect((preparedCore as Record<symbol, unknown>)[BEFORE_TOOL_CALL_SOURCE_TOOL]).toBe(
      coreSource,
    );
    expect((preparedCore as Record<symbol, unknown>)[BEFORE_TOOL_CALL_HOOK_CONTEXT]).toBe(
      originalContext,
    );
    expect((preparedMcp as Record<symbol, unknown>)[BEFORE_TOOL_CALL_SOURCE_TOOL]).toBe(mcpTool);
    expect((preparedLsp as Record<symbol, unknown>)[BEFORE_TOOL_CALL_SOURCE_TOOL]).toBe(lspTool);
    expect((preparedMcp as Record<symbol, unknown>)[BEFORE_TOOL_CALL_HOOK_CONTEXT]).toBe(
      result.catalogToolHookContext,
    );
    expect((preparedLsp as Record<symbol, unknown>)[BEFORE_TOOL_CALL_HOOK_CONTEXT]).toBe(
      result.catalogToolHookContext,
    );
  });

  it("projects a direct bundle MCP call to one metadata-only audit lifecycle", async () => {
    const mcpSession = createSessionMcpRuntime("private-result");
    const materializedMcp = await materializeBundleMcpToolsForRun({
      runtime: mcpSession.runtime,
    });
    const mcpTool = materializedMcp.tools[0];
    if (!mcpTool) {
      throw new Error("expected one materialized MCP tool");
    }
    const preparedMcp = prepareCatalog([mcpTool]).effectiveTools[0];
    const auditInputs: AuditEventInput[] = [];
    const recorder = createAgentEventAuditRecorder({ writer: captureAuditWriter(auditInputs) });
    const stopListening = onTrustedToolExecutionEvent(recorder.recordTool);

    try {
      await preparedMcp?.execute(
        "call-private-id",
        { secret: "private-input" },
        undefined,
        undefined,
      );
    } finally {
      stopListening();
      await recorder.stop();
    }

    expect(auditInputs).toHaveLength(2);
    expect(auditInputs).toMatchObject([
      {
        kind: "tool_action",
        action: "tool.action.started",
        status: "started",
        runId: RUN_ID,
        sessionId: "session-id",
        sessionKey: "agent:main:main",
        agentId: "main",
        toolName: "demo__read",
      },
      {
        kind: "tool_action",
        action: "tool.action.finished",
        status: "succeeded",
        runId: RUN_ID,
        sessionId: "session-id",
        sessionKey: "agent:main:main",
        agentId: "main",
        toolName: "demo__read",
      },
    ]);
    const toolCallIds = auditInputs.map((input) =>
      "toolCallId" in input ? input.toolCallId : undefined,
    );
    expect(toolCallIds[0]).toMatch(/^sha256:/);
    expect(toolCallIds[1]).toBe(toolCallIds[0]);
    expect(JSON.stringify(auditInputs)).not.toContain("call-private-id");
    expect(JSON.stringify(auditInputs)).not.toContain("private-input");
    expect(JSON.stringify(auditInputs)).not.toContain("private-result");
    expect(mcpSession.callTool).toHaveBeenCalledOnce();
  });
});
