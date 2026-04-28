import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { vi } from "vitest";
import { __testing as beforeToolCallTesting } from "../../../agents/pi-tools.before-tool-call.js";
import type {
  CodexAppServerExtensionFactory,
  CodexAppServerToolResultEvent,
} from "../../../plugins/codex-app-server-extension-types.js";
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
  handler: (event: CodexAppServerToolResultEvent) => AgentToolResult<unknown>,
) {
  const middleware = vi.fn(async (event: CodexAppServerToolResultEvent) => ({
    result: handler(event),
  }));
  const registry = createEmptyPluginRegistry();
  const factory: CodexAppServerExtensionFactory = async (codex) => {
    codex.on("tool_result", middleware);
  };
  registry.codexAppServerExtensionFactories.push({
    pluginId: "runtime-contract",
    pluginName: "Runtime Contract",
    rawFactory: factory,
    factory,
    source: "test",
  });
  setActivePluginRegistry(registry);
  return { middleware };
}

export function resetOpenClawOwnedToolHooks(): void {
  resetGlobalHookRunner();
  resetPluginRuntimeStateForTest();
  beforeToolCallTesting.adjustedParamsByToolCallId.clear();
}
