import {
  createToolSearchCatalogRef,
  registerHeadlessToolSearchCatalog,
} from "../agents/tool-search-catalog.js";
import { resolveToolSearchConfig } from "../agents/tool-search-config.js";
import { executeInternalToolSearchRequest } from "../agents/tool-search-execute.js";
import { TOOL_SEARCH_RAW_TOOL_NAME } from "../agents/tool-search-types.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

/** Build the non-model Tool Search compatibility tool for Gateway tool invocation. */
export function createGatewayToolSearchInvokeTool(params: {
  cfg: OpenClawConfig;
  tools: readonly AnyAgentTool[];
  agentId?: string;
  sessionKey: string;
  sessionId?: string;
  signal?: AbortSignal;
}): AnyAgentTool | undefined {
  if (!resolveToolSearchConfig(params.cfg).enabled) {
    return undefined;
  }
  const catalogRef = createToolSearchCatalogRef();
  registerHeadlessToolSearchCatalog({ catalogRef, tools: params.tools });
  return {
    name: TOOL_SEARCH_RAW_TOOL_NAME,
    label: "Tool Search",
    description:
      "Search the effective Gateway tool inventory with one query or a bounded batch of queries.",
    // This schema is used by the non-model tools.invoke surface. Runtime parsing
    // enforces the exclusive scalar-or-batch contract and all aggregate limits.
    parameters: { type: "object" },
    execute: async (_toolCallId: string, args: unknown, signal?: AbortSignal) =>
      await executeInternalToolSearchRequest(
        {
          config: params.cfg,
          runtimeConfig: params.cfg,
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          sessionId: params.sessionId,
          catalogRef,
          abortSignal: signal ?? params.signal,
        },
        args,
      ),
  };
}
