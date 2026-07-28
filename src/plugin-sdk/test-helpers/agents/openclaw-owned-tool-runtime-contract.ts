// OpenClaw-owned tool runtime contract helpers mock agent tool runtimes in SDK tests.
import { vi } from "vitest";
import { resetAdjustedParamsByToolCallIdForTests } from "../../../agents/agent-tools.before-tool-call.state.js";
import type { AgentToolResult } from "../../../agents/runtime/index.js";
import { setToolTerminalPresentation } from "../../../agents/tool-terminal-presentation.js";
import type { AnyAgentTool } from "../../../agents/tools/common.js";
import type { AgentToolResultMiddlewareEvent } from "../../../plugins/agent-tool-result-middleware-types.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../../plugins/hooks.test-helpers.js";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import {
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../../plugins/runtime.js";

export function textToolResult(
  text: string,
  details: Record<string, unknown> = {},
): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text }],
    details,
  };
}

export function mediaToolResult(
  text: string,
  mediaUrl: string,
  audioAsVoice = false,
): AgentToolResult<unknown> {
  return textToolResult(text, {
    media: {
      mediaUrl,
      ...(audioAsVoice ? { audioAsVoice } : {}),
    },
  });
}

export function createTerminalPresentationContractTool(params: {
  name: string;
  result: AgentToolResult<unknown>;
  format: (params: unknown, result: AgentToolResult<unknown>) => string | undefined;
}): AnyAgentTool {
  return setToolTerminalPresentation(
    {
      name: params.name,
      label: `${params.name} contract tool`,
      description: `${params.name} contract tool`,
      parameters: {},
      execute: vi.fn(async () => params.result),
    } as AnyAgentTool,
    (toolParams, result) => {
      const text = params.format(toolParams, result);
      return text ? { text } : undefined;
    },
  );
}

export function installOpenClawOwnedToolHooks(params?: {
  adjustedParams?: Record<string, unknown>;
  blockReason?: string;
}) {
  const beforeToolCall = vi.fn(async () => {
    if (params?.blockReason) {
      return {
        block: true,
        blockReason: params.blockReason,
      };
    }
    return params?.adjustedParams ? { params: params.adjustedParams } : {};
  });
  const afterToolCall = vi.fn(async () => {});
  initializeGlobalHookRunner(
    createMockPluginRegistry([
      { hookName: "before_tool_call", handler: beforeToolCall },
      { hookName: "after_tool_call", handler: afterToolCall },
    ]),
  );
  return { beforeToolCall, afterToolCall };
}

/**
 * Installs only the Codex app-server `tool_result` middleware fixture.
 * Pair with `installOpenClawOwnedToolHooks()` when a test asserts before/after hook behavior.
 */
export function installCodexToolResultMiddleware(
  handler: (event: AgentToolResultMiddlewareEvent) => AgentToolResult<unknown>,
) {
  const middleware = vi.fn(async (event: AgentToolResultMiddlewareEvent) => ({
    result: handler(event),
  }));
  const registry = createEmptyPluginRegistry();
  registry.agentToolResultMiddlewares.push({
    pluginId: "runtime-contract",
    pluginName: "Runtime Contract",
    rawHandler: middleware,
    handler: middleware,
    runtimes: ["codex"],
    source: "test",
  });
  setActivePluginRegistry(registry);
  return { middleware };
}

export function resetOpenClawOwnedToolHooks(): void {
  resetGlobalHookRunner();
  resetPluginRuntimeStateForTest();
  resetAdjustedParamsByToolCallIdForTests();
}
