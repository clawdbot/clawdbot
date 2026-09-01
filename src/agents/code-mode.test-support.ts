import { expect, vi } from "vitest";
import { setPluginToolMeta } from "../plugins/tool-metadata.js";
import { codeModeReplayIdForToolCall } from "./code-mode-bridge.js";
import { resolveCodeModeHeadlessConfig } from "./code-mode-runtime.js";
import type { CodeModeSkill } from "./code-mode-skills.js";
import {
  activeRuns,
  disposeAllCodeModeRuns,
  removeExpiredRuns,
  resumingRunIds,
} from "./code-mode-state.js";
import { normalizeCodeModeWorkerResult, runCodeModeWorker } from "./code-mode-worker.js";
import { createCodeModeTools } from "./code-mode.js";
import {
  createToolSearchCatalogRef,
  registerHeadlessToolSearchCatalog,
  type ToolSearchCatalogRef,
  type ToolSearchToolContext,
} from "./tool-search.js";
import { jsonResult, type AnyAgentTool } from "./tools/common.js";

export const testing = {
  activeRuns,
  resumingRunIds,
  codeModeReplayIdForToolCall,
  removeExpiredRuns,
  normalizeCodeModeWorkerResult,
  runCodeModeWorker,
  resolveCodeModeHeadlessConfig,
};

export function resetCodeModeTestState(): void {
  disposeAllCodeModeRuns();
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

/** Compare public summaries to independently constructed, normalized guest data. */
export function expectOriginalCodeModeMarker(marker: unknown, original: unknown): void {
  expect(marker).toMatchObject({
    truncated: true,
    guidance: "Output truncated; rerun with narrower args.",
    prefix: expect.any(String),
    omittedBytes: expect.any(Number),
  });
  const { prefix, omittedBytes } = marker as { prefix: string; omittedBytes: number };
  const serialized = JSON.stringify(original);
  expect(serialized.startsWith(prefix), "summary must retain the original JSON prefix").toBe(true);
  expect(omittedBytes).toBe(Buffer.byteLength(serialized) - Buffer.byteLength(prefix));
  expect(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(prefix))).toBe(prefix);
}

export function expectCodeModeSharedBudget(
  result: { output?: unknown; value?: unknown; error?: unknown },
  maxBytes: number,
): void {
  let bytes = 0;
  for (const field of ["output", "value", "error"] as const) {
    if (!Object.hasOwn(result, field)) {
      continue;
    }
    const value = result[field];
    if (field === "output" && Array.isArray(value) && value.length === 0) {
      continue;
    }
    bytes += Buffer.byteLength(JSON.stringify(value));
  }
  expect(bytes).toBeLessThanOrEqual(maxBytes);
}

export function createHeadlessCodeModeHarness(
  tools: AnyAgentTool[] = [],
  options: { swarmEnabled?: boolean } = {},
): ToolSearchToolContext {
  const config = {
    tools: {
      codeMode: { enabled: false, timeoutMs: 60_000 },
      ...(options.swarmEnabled ? { swarm: true } : {}),
    },
  } as never;
  const catalogRef = createToolSearchCatalogRef();
  registerHeadlessToolSearchCatalog({ catalogRef, tools });
  return {
    config,
    runtimeConfig: config,
    agentId: "main",
    catalogRef,
  };
}

export function createCodeModeHarness(
  params: {
    agentId?: string;
    catalogRef?: ToolSearchCatalogRef;
    codeModeSkills?: readonly CodeModeSkill[];
    forceRestartSafeTools?: boolean;
  } = {},
) {
  const catalogRef = params.catalogRef ?? createToolSearchCatalogRef();
  const config = { tools: { codeMode: true } } as never;
  const ctx = {
    config,
    runtimeConfig: config,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    sessionId: "session-code-mode",
    sessionKey: params.agentId ? `agent:${params.agentId}:main` : "agent:main:main",
    runId: "run-code-mode",
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
  restartSafe?: boolean;
}) {
  const details = resultDetails(
    await params.execTool.execute("code-call-1", {
      code: params.code,
      language: params.language,
      restartSafe: params.restartSafe,
    }),
  );
  return await waitUntilCompleted({ details, waitTool: params.waitTool });
}

export async function waitUntilCompleted(params: {
  details: Record<string, unknown>;
  waitTool: AnyAgentTool;
}) {
  // Resume the existing run through public waits; never replay its actions.
  let details = params.details;
  for (let index = 0; index < 8 && details.status === "waiting"; index += 1) {
    const runId = details.runId;
    expect(typeof runId).toBe("string");
    details = resultDetails(await params.waitTool.execute(`code-wait-${index}`, { runId }));
  }
  return details;
}
