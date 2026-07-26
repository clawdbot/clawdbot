import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
// Memory Core helper module supports tools helpers behavior.
import { expect } from "vitest";
import type { OpenClawConfig } from "../api.js";
import { createMemoryGetTool, createMemorySearchTool } from "./tools.js";

export function asOpenClawConfig(config: Partial<OpenClawConfig>): OpenClawConfig {
  return config;
}

export function createDefaultMemoryToolConfig(): OpenClawConfig {
  return asOpenClawConfig({ agents: { list: [{ id: "main", default: true }] } });
}

export function createMemorySearchToolOrThrow(params?: {
  config?: OpenClawConfig;
  agentId?: string;
  agentSessionKey?: string;
  oneShotCliRun?: boolean;
  conversationRecall?: OpenClawPluginToolContext["conversationRecall"];
}) {
  const tool = createMemorySearchTool({
    config: params?.config ?? createDefaultMemoryToolConfig(),
    ...(params?.agentId ? { agentId: params.agentId } : {}),
    ...(params?.agentSessionKey ? { agentSessionKey: params.agentSessionKey } : {}),
    ...(params?.oneShotCliRun ? { oneShotCliRun: params.oneShotCliRun } : {}),
    ...(params?.conversationRecall ? { conversationRecall: params.conversationRecall } : {}),
  });
  if (!tool) {
    throw new Error("tool missing");
  }
  return tool;
}

export function createMemoryGetToolOrThrow(
  config: OpenClawConfig = createDefaultMemoryToolConfig(),
) {
  const tool = createMemoryGetTool({ config });
  if (!tool) {
    throw new Error("tool missing");
  }
  return tool;
}

export function createAutoCitationsMemorySearchTool(agentSessionKey: string) {
  return createMemorySearchToolOrThrow({
    config: asOpenClawConfig({
      memory: { citations: "auto" },
      agents: { list: [{ id: "main", default: true }] },
    }),
    agentSessionKey,
  });
}

export const MEMORY_SEARCH_TIMEOUT_WARNING =
  "Memory search is unavailable because it timed out before completing; this can be local index maintenance rather than an embedding provider fault.";
export const MEMORY_SEARCH_TIMEOUT_ACTION =
  "Check memory index status (openclaw memory status --index) before retrying memory_search.";

/**
 * Diagnostics the memory_search tool attaches when it fails inside a run.
 * Payloads built outside a run carry none of these.
 */
export function memorySearchFailureDebug(params?: {
  timedOut?: boolean;
  phase?: "memory" | "supplement";
}): Record<string, unknown> {
  return {
    elapsedMs: expect.any(Number),
    timedOut: params?.timedOut ?? false,
    ...(params?.phase ? { phase: params.phase } : {}),
  };
}

export function expectUnavailableMemorySearchDetails(
  details: unknown,
  params: {
    error: string;
    warning: string;
    action: string;
    /** Failure diagnostics merged into `debug`; see `memorySearchFailureDebug`. */
    debug?: Record<string, unknown>;
    cached?: boolean;
    cooldownRemainingMs?: number;
  },
) {
  expect(details).toEqual({
    results: [],
    disabled: true,
    unavailable: true,
    error: params.error,
    warning: params.warning,
    action: params.action,
    ...(params.cached === undefined ? {} : { cached: params.cached }),
    ...(params.cooldownRemainingMs === undefined
      ? {}
      : { cooldownRemainingMs: params.cooldownRemainingMs }),
    debug: {
      warning: params.warning,
      action: params.action,
      error: params.error,
      ...params.debug,
    },
  });
}
