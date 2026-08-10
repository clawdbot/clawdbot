import { expect, vi } from "vitest";
import { setPluginToolMeta } from "../plugins/tools.js";
import type { CodeModeActivityOwner } from "./code-mode-activity.js";
import type { CodeModePrivateAuthority } from "./code-mode-private-authority.js";
import type { CodeModeWorkerResult } from "./code-mode-runtime.js";
import type { CodeModeSkill } from "./code-mode-skills.js";
import { createCodeModeTools } from "./code-mode.js";
import {
  createToolSearchCatalogRef,
  type ToolSearchCatalogRef,
  type ToolSearchToolContext,
} from "./tool-search.js";
import { jsonResult, type AnyAgentTool } from "./tools/common.js";

type CodeModeConfig = {
  enabled: boolean;
  runtime: "quickjs-wasi";
  mode: "only";
  languages: ("javascript" | "typescript")[];
  timeoutMs: number;
  memoryLimitBytes: number;
  maxOutputBytes: number;
  maxSnapshotBytes: number;
  maxPendingToolCalls: number;
  snapshotTtlSeconds: number;
  searchDefaultLimit: number;
  maxSearchLimit: number;
};

type CodeModeTestApi = {
  activeRuns: Map<
    string,
    {
      runId: string;
      config: CodeModeConfig;
      privateAuthority: CodeModePrivateAuthority;
      expiresAt: number;
      replayId?: string;
      agentWaitRetainUntil?: number;
      pending: Array<{
        id: string;
        method: string;
        args: unknown[];
        promise: Promise<unknown>;
        settled?: unknown;
        cancel?: () => void;
      }>;
    }
  >;
  resumingRunIds: Set<string>;
  codeModeReplayIdForToolCall(
    ctx: ToolSearchToolContext,
    toolCallId: string,
    code: string,
    assistantTurnId?: string,
  ): string;
  removeExpiredRuns(now?: number): void;
  disposeAllCodeModeRuns(): void;
  runBridgeRequest(
    params: Record<string, unknown>,
  ): Promise<{ id: string; ok: true; value: unknown } | { id: string; ok: false; error: string }>;
  createHeadlessAbortScope(
    signal: AbortSignal | undefined,
    wallClockMs: number,
  ): { signal: AbortSignal; cleanup: () => void };
  normalizeCodeModeWorkerResult(result: CodeModeWorkerResult): CodeModeWorkerResult;
  runCodeModeWorker(options: {
    workerData: unknown;
    timeoutMs: number;
    workerUrl?: URL;
    signal?: AbortSignal;
    onWorkerSpawned?: () => void;
  }): Promise<CodeModeWorkerResult>;
  resolveCodeModeHeadlessConfig(
    ctx: ToolSearchToolContext,
    overrides?: Partial<
      Pick<
        CodeModeConfig,
        | "timeoutMs"
        | "memoryLimitBytes"
        | "maxOutputBytes"
        | "maxSnapshotBytes"
        | "maxPendingToolCalls"
      >
    >,
  ): CodeModeConfig;
  resolveCodeModeWorkerUrl(currentModuleUrl: string): URL;
  getTypescriptRuntimePromise(): Promise<typeof import("typescript")> | null;
  setTypescriptRuntimeForTest(
    runtime: typeof import("typescript") | Promise<typeof import("typescript")> | null,
  ): void;
  setSwarmDepsForTest(overrides?: {
    emitSessionLifecycleEvent?: (event: Record<string, unknown>) => void;
    getSwarmRunByLaunchReplayKey?: (key: string, requesterSessionKey?: string) => unknown;
    initSubagentRegistry?: () => void;
    waitForCollectorCompletion?: (params: Record<string, unknown>) => Promise<unknown>;
  }): void;
};

function getTestApi(): CodeModeTestApi {
  const api = (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.codeModeTestApi")];
  if (!api) {
    throw new Error("code mode test API is unavailable");
  }
  return api as CodeModeTestApi;
}

export const testing = getTestApi();

export function resetCodeModeTestState(): void {
  testing.disposeAllCodeModeRuns();
  testing.resumingRunIds.clear();
  testing.setTypescriptRuntimeForTest(null);
}

export function fakeTool(name: string, description: string): AnyAgentTool {
  // Minimal tool shape keeps Code Mode catalog tests runtime-free.
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

export function pluginTool(
  name: string,
  description: string,
  pluginId = "fake-code-mode",
): AnyAgentTool {
  const tool = fakeTool(name, description);
  setPluginToolMeta(tool, {
    pluginId,
    optional: true,
  });
  return tool;
}

export function pluginToolWithExecute(
  name: string,
  description: string,
  execute: AnyAgentTool["execute"],
): AnyAgentTool {
  const tool = pluginTool(name, description);
  tool.execute = vi.fn(execute) as AnyAgentTool["execute"];
  return tool;
}

export function mcpTool(params: {
  name: string;
  serverName: string;
  safeServerName?: string;
  toolName: string;
  description?: string;
  parameters?: AnyAgentTool["parameters"];
  operation?: "tool" | "resources_list" | "resources_read" | "prompts_list" | "prompts_get";
  execute?: AnyAgentTool["execute"];
}): AnyAgentTool {
  // MCP metadata drives Code Mode grouping and raw tool routing.
  const tool: AnyAgentTool = {
    name: params.name,
    label: params.toolName,
    description: params.description ?? `MCP ${params.toolName}`,
    parameters: params.parameters ?? {
      type: "object",
      properties: {},
    },
    execute:
      params.execute ??
      vi.fn(async (_toolCallId, input) =>
        jsonResult({
          serverName: params.serverName,
          toolName: params.toolName,
          input,
        }),
      ),
  };
  setPluginToolMeta(tool, {
    pluginId: "bundle-mcp",
    optional: false,
    mcp: {
      serverName: params.serverName,
      safeServerName: params.safeServerName ?? params.serverName,
      toolName: params.toolName,
      operation: params.operation ?? "tool",
    },
  });
  return tool;
}

export function resultDetails(result: { details?: unknown }): Record<string, unknown> {
  expect(result.details).toBeDefined();
  expect(typeof result.details).toBe("object");
  return result.details as Record<string, unknown>;
}

export function createCodeModeHarness(
  params: {
    agentId?: string;
    catalogRef?: ToolSearchCatalogRef;
    codeModeActivityOwner?: CodeModeActivityOwner;
    codeModeSkills?: readonly CodeModeSkill[];
    forceRestartSafeTools?: boolean;
    swarmEnabled?: boolean;
  } = {},
) {
  const catalogRef = params.catalogRef ?? createToolSearchCatalogRef();
  const config = {
    tools: {
      codeMode: true,
      ...(params.swarmEnabled ? { swarm: { enabled: true } } : {}),
    },
  } as never;
  const ctx = {
    config,
    runtimeConfig: config,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    sessionId: "session-code-mode",
    sessionKey: params.agentId ? `agent:${params.agentId}:main` : "agent:main:main",
    runId: "run-code-mode",
    codeModeActivityOwner: params.codeModeActivityOwner,
    catalogRef,
    forceRestartSafeTools: params.forceRestartSafeTools,
    codeModeSkills: params.codeModeSkills,
  };
  const tools = createCodeModeTools(ctx);
  return { catalogRef, config, ctx, tools };
}

export async function runUntilCompleted(params: {
  execTool: AnyAgentTool;
  waitTool: AnyAgentTool;
  code: string;
  language?: "javascript" | "typescript";
}) {
  // Code Mode may return a waiting state before completion; tests poll through
  // the public wait tool instead of reaching into activeRuns.
  let details = resultDetails(
    await params.execTool.execute("code-call-1", {
      code: params.code,
      language: params.language,
    }),
  );
  for (let index = 0; index < 8 && details.status === "waiting"; index += 1) {
    const runId = details.runId;
    expect(typeof runId).toBe("string");
    details = resultDetails(await params.waitTool.execute(`code-wait-${index}`, { runId }));
  }
  return details;
}
