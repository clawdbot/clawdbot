import { createSubsystemLogger } from "../logging/subsystem.js";
import { copyPluginToolMeta } from "../plugins/tool-metadata.js";
import { isCompletionReportInputProvenance } from "../sessions/input-provenance.js";
import { createRuntimeToolMatcher } from "./tool-policy-match.js";
import { normalizeToolPolicyName } from "./tool-policy.js";
import { AUTOMATIONS_TOOL_NAME } from "./tools/automations-tool-name.js";
import type { AnyAgentTool } from "./tools/common.js";
import { ToolAuthorizationError } from "./tools/common.js";

const log = createSubsystemLogger("agents/delegation-capability");

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
  const delegationAllowed = [...NEW_DELEGATION_TOOL_NAMES].some(
    createRuntimeToolMatcher(params.toolsAllow),
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
  const wrapped = new Proxy(tool, {
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
  // Plugin ownership lives in a WeakMap keyed by tool identity, so the proxy
  // needs its own entry; otherwise plugin-owned report-only tools drop out of
  // the effective cron-creator allowlist for the rest of the run.
  copyPluginToolMeta(tool, wrapped);
  return wrapped;
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
  const removed: string[] = [];
  const narrowed: string[] = [];
  const gated = tools.flatMap((tool) => {
    const name = normalizeToolPolicyName(tool.name);
    if (NEW_DELEGATION_TOOL_NAMES.has(name)) {
      removed.push(name);
      return [];
    }
    const allowedActions = REPORT_ONLY_TOOL_ACTIONS.get(name);
    if (!allowedActions) {
      return [tool];
    }
    narrowed.push(name);
    return [wrapReportOnlyTool(tool, allowedActions)];
  });
  if (removed.length > 0 || narrowed.length > 0) {
    // Removal is otherwise invisible: the model simply never sees the tool and
    // no error is raised. Record it so a fallback completion turn stays
    // auditable after the fact.
    log.debug("delegation capability restricted run tools", {
      removed,
      narrowed,
    });
  }
  return gated;
}
