/**
 * OpenClaw-owned tool registration filters.
 *
 * Keeps optional tool gating separate from tool construction so config and execution contracts decide exposure.
 */
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isPrimaryBootstrapRun } from "./bootstrap-routing.js";
import { isStrictAgenticExecutionContractActive } from "./execution-contract.js";
import { isToolAllowedByPolicyName } from "./tool-policy-match.js";
import type { AnyAgentTool } from "./tools/common.js";

/**
 * Registration helpers for optional OpenClaw-owned tools.
 *
 * This keeps model/runtime gating separate from tool construction so callers can
 * assemble candidate tools first, then filter by config and execution contract.
 */
/** Drops disabled optional tools while preserving candidate order. */
export function collectPresentOpenClawTools(
  candidates: readonly (AnyAgentTool | null | undefined)[],
): AnyAgentTool[] {
  return candidates.filter((tool): tool is AnyAgentTool => tool !== null && tool !== undefined);
}

/**
 * Resolves whether update_plan is enabled by experimental flag or GPT-5 strict-agentic auto-enable.
 *
 * Matches docs/gateway/config-tools.md: default off unless planTool is true or a supported
 * strict-agentic GPT-5 OpenAI/Codex run is active. Explicit `planTool: false` is a kill switch.
 */
function isUpdatePlanToolEnabledForOpenClawTools(params: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
  agentId?: string | null;
  modelProvider?: string;
  modelId?: string;
}): boolean {
  const configured = params.config?.tools?.experimental?.planTool;
  if (configured === false) {
    return false;
  }
  if (configured === true) {
    return true;
  }
  return isStrictAgenticExecutionContractActive({
    config: params.config,
    sessionKey: params.agentSessionKey,
    agentId: params.agentId,
    provider: params.modelProvider,
    modelId: params.modelId,
  });
}

/** True when an operator/runtime allowlist explicitly requests update_plan (or a group that expands to it). */
function isUpdatePlanExplicitlyAllowedForOpenClawTools(params: {
  config?: OpenClawConfig;
  pluginToolAllowlist?: string[];
}): boolean {
  const allowlist = uniqueStrings([
    ...(params.config?.tools?.allow ?? []),
    ...(params.config?.tools?.alsoAllow ?? []),
    ...(params.pluginToolAllowlist ?? []),
  ]);
  if (!allowlist.some((entry) => typeof entry === "string" && entry.trim().length > 0)) {
    return false;
  }
  return isToolAllowedByPolicyName("update_plan", { allow: allowlist });
}

/** Decides whether update_plan should be included in the assembled OpenClaw tool set. */
export function shouldIncludeUpdatePlanToolForOpenClawTools(params: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
  agentId?: string | null;
  modelProvider?: string;
  modelId?: string;
  pluginToolAllowlist?: string[];
  pluginToolDenylist?: string[];
}): boolean {
  const deny = uniqueStrings([
    ...(params.config?.tools?.deny ?? []),
    ...(params.pluginToolDenylist ?? []),
  ]);
  if (!isToolAllowedByPolicyName("update_plan", { deny })) {
    return false;
  }
  // Kill switch wins over allowlists and strict-agentic auto-enable.
  if (params.config?.tools?.experimental?.planTool === false) {
    return false;
  }
  return (
    isUpdatePlanToolEnabledForOpenClawTools(params) ||
    isUpdatePlanExplicitlyAllowedForOpenClawTools(params)
  );
}

/** Includes ask_user only on a primary session and when normal deny policy permits it. */
export function shouldIncludeAskUserToolForOpenClawTools(params: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
  pluginToolDenylist?: string[];
}): boolean {
  const sessionKey = params.agentSessionKey?.trim();
  if (!sessionKey) {
    return false;
  }
  const deny = uniqueStrings([
    ...(params.config?.tools?.deny ?? []),
    ...(params.pluginToolDenylist ?? []),
  ]);
  return isPrimaryBootstrapRun(sessionKey) && isToolAllowedByPolicyName("ask_user", { deny });
}
