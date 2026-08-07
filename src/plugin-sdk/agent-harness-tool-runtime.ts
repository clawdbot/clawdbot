import {
  createOpenClawCodingToolsForAgentHarness as createCoreOpenClawCodingToolsForAgentHarness,
  createOpenClawCodingToolsForAgentHarnessSideQuestion as createCoreOpenClawCodingToolsForAgentHarnessSideQuestion,
} from "../agents/agent-tools-internal.js";
/**
 * Packaged private runtime facade for official harness plugins.
 *
 * This subpath is local-only and declaration-excluded. Keep tool-search and
 * code-mode dependencies out of the lightweight startup lifecycle facade.
 */
import {
  createAgentHarnessToolSurfaceRuntime as createCoreAgentHarnessToolSurfaceRuntime,
  type AgentHarnessToolSurfaceRuntime as CoreAgentHarnessToolSurfaceRuntime,
} from "../agents/harness/tool-surface-bridge.js";
import type {
  AgentHarnessSideQuestionParams,
  EmbeddedRunAttemptParams,
} from "./agent-harness-runtime.js";

type OpenClawCodingToolsOptions = NonNullable<
  Parameters<typeof import("./agent-harness.js").createOpenClawCodingTools>[0]
>;

export type AgentHarnessToolSurfaceRuntime = Omit<
  CoreAgentHarnessToolSurfaceRuntime,
  "toolSearchCatalogExecutor" | "toolSearchCatalogRef"
> & {
  toolSearchCatalogExecutor: OpenClawCodingToolsOptions["toolSearchCatalogExecutor"];
  toolSearchCatalogRef: OpenClawCodingToolsOptions["toolSearchCatalogRef"];
};

export type AgentHarnessToolSurfaceRuntimeParams = Omit<
  Parameters<typeof createCoreAgentHarnessToolSurfaceRuntime>[0],
  "executeTool"
> & {
  executeTool: NonNullable<OpenClawCodingToolsOptions["toolSearchCatalogExecutor"]>;
};

export function createAgentHarnessToolSurfaceRuntime(
  params: AgentHarnessToolSurfaceRuntimeParams,
): AgentHarnessToolSurfaceRuntime {
  return createCoreAgentHarnessToolSurfaceRuntime(params);
}

/**
 * Build tools for the exact host-admitted attempt without exposing its private
 * execution attribution to plugin code.
 */
export function createOpenClawCodingToolsForAgentHarness(
  attempt: EmbeddedRunAttemptParams,
  options?: OpenClawCodingToolsOptions,
): ReturnType<typeof createCoreOpenClawCodingToolsForAgentHarness> {
  return createCoreOpenClawCodingToolsForAgentHarness(attempt, options);
}

/**
 * Build tools for the exact host-admitted side-question request without
 * exposing its private execution attribution to plugin code.
 */
export function createOpenClawCodingToolsForAgentHarnessSideQuestion(
  params: AgentHarnessSideQuestionParams,
  options?: OpenClawCodingToolsOptions,
): ReturnType<typeof createCoreOpenClawCodingToolsForAgentHarnessSideQuestion> {
  return createCoreOpenClawCodingToolsForAgentHarnessSideQuestion(params, options);
}
