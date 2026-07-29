import { isCompletionReportInputProvenance } from "../sessions/input-provenance.js";
import { normalizeToolName } from "./tool-policy.js";
import type { AnyAgentTool } from "./tools/common.js";
import { ToolAuthorizationError } from "./tools/common.js";

export type DelegationCapability = "full" | "report_only";

const NEW_DELEGATION_TOOL_NAMES = new Set([
  "codex_session_send",
  "llm-task",
  "openclaw",
  "sessions_send",
  "sessions_spawn",
]);

const REPORT_ONLY_TOOL_ACTIONS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["cron", new Set(["get", "list", "remove", "runs", "status"])],
  ["image_generate", new Set(["list", "status"])],
  ["music_generate", new Set(["list", "status"])],
  ["video_generate", new Set(["list", "status"])],
]);

const REPORT_ONLY_ERROR =
  "New delegation is unavailable while reporting a completion through a fallback model.";

export function resolveDelegationCapability(params: {
  fallbackActive: boolean;
  inputProvenance: unknown;
}): DelegationCapability {
  return params.fallbackActive && isCompletionReportInputProvenance(params.inputProvenance)
    ? "report_only"
    : "full";
}

function readToolAction(params: unknown): string {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return "";
  }
  const action = (params as { action?: unknown }).action;
  return typeof action === "string" ? action.trim().toLowerCase() : "";
}

function wrapReportOnlyTool(tool: AnyAgentTool, allowedActions: ReadonlySet<string>): AnyAgentTool {
  return new Proxy(tool, {
    get(target, property, receiver) {
      if (property !== "execute") {
        return Reflect.get(target, property, receiver);
      }
      return async (
        toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
        onUpdate?: Parameters<AnyAgentTool["execute"]>[3],
      ) => {
        if (!allowedActions.has(readToolAction(params))) {
          throw new ToolAuthorizationError(REPORT_ONLY_ERROR);
        }
        return await Reflect.apply(target.execute, undefined, [
          toolCallId,
          params,
          signal,
          onUpdate,
        ]);
      };
    },
  });
}

/**
 * Enforces the run's delegation capability after ordinary tool authorization.
 * Tool names and safe actions here are explicit built-in/plugin contracts: the
 * gate removes task launchers while retaining status, history, and cleanup.
 */
export function applyDelegationCapability(
  tools: AnyAgentTool[],
  capability: DelegationCapability | undefined,
): AnyAgentTool[] {
  if (capability !== "report_only") {
    return tools;
  }
  return tools.flatMap((tool) => {
    const name = normalizeToolName(tool.name);
    if (NEW_DELEGATION_TOOL_NAMES.has(name)) {
      return [];
    }
    const allowedActions = REPORT_ONLY_TOOL_ACTIONS.get(name);
    return allowedActions ? [wrapReportOnlyTool(tool, allowedActions)] : [tool];
  });
}
