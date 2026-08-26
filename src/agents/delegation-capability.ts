import { isCompletionReportInputProvenance } from "../sessions/input-provenance.js";
import { isRuntimeToolAllowed } from "./tool-policy-match.js";
import { normalizeToolPolicyName } from "./tool-policy.js";
import { AUTOMATIONS_TOOL_NAME } from "./tools/automations-tool-name.js";
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
  [AUTOMATIONS_TOOL_NAME, new Set(["get", "list", "remove", "runs", "status"])],
  ["image_generate", new Set(["list", "status"])],
  ["music_generate", new Set(["list", "status"])],
  ["video_generate", new Set(["list", "status"])],
]);

const REPORT_ONLY_ERROR =
  "New delegation is unavailable while reporting a completion through a fallback model.";

export function resolveDelegationCapability(params: {
  fallbackActive: boolean;
  inputProvenance: unknown;
  disableTools?: boolean;
  toolsAllow?: string[];
}): DelegationCapability {
  if (!isCompletionReportInputProvenance(params.inputProvenance)) {
    return "full";
  }
  if (params.fallbackActive || params.disableTools === true) {
    return "report_only";
  }
  if (params.toolsAllow === undefined) {
    return "full";
  }

  // Native harness delegation is outside the dynamic-tool allowlist, so carry
  // its actual launch authority through the shared attempt capability.
  const delegationAllowed = [...NEW_DELEGATION_TOOL_NAMES].some((toolName) =>
    isRuntimeToolAllowed(toolName, params.toolsAllow),
  );
  return delegationAllowed ? "full" : "report_only";
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
        return await target.execute(toolCallId, params, signal, onUpdate);
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
    const name = normalizeToolPolicyName(tool.name);
    if (NEW_DELEGATION_TOOL_NAMES.has(name)) {
      return [];
    }
    const allowedActions = REPORT_ONLY_TOOL_ACTIONS.get(name);
    return allowedActions ? [wrapReportOnlyTool(tool, allowedActions)] : [tool];
  });
}
