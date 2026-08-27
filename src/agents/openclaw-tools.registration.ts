/**
 * OpenClaw-owned tool registration filters.
 *
 * Keeps optional tool gating separate from tool construction so config and execution contracts decide exposure.
 */
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveEffectiveToolPolicy } from "./agent-tools.policy.js";
import { isPrimaryBootstrapRun } from "./bootstrap-routing.js";
import {
  isRuntimeToolAllowed,
  isToolAllowedByPolicies,
  isToolAllowedByPolicyName,
} from "./tool-policy-match.js";
import {
  expandShippedCoreToolPolicyNames,
  mergeAlsoAllowPolicy,
  resolveToolProfilePolicy,
  type ToolPolicyLike,
} from "./tool-policy.js";
import type { AnyAgentTool } from "./tools/common.js";

function expandProgressCardPolicyNames(
  policy: ToolPolicyLike | undefined,
): ToolPolicyLike | undefined {
  return policy
    ? {
        allow: expandShippedCoreToolPolicyNames(policy.allow),
        deny: expandShippedCoreToolPolicyNames(policy.deny),
      }
    : undefined;
}

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

/** Decides whether progress_card should be included in the assembled OpenClaw tool set. */
export function shouldIncludeProgressCardToolForOpenClawTools(params: {
  agentId?: string;
  agentSessionKey?: string;
  config?: OpenClawConfig;
  modelId?: string;
  modelProvider?: string;
  pluginToolDenylist?: string[];
  runtimeToolAllowlist?: string[];
}): boolean {
  // `tools.updatePlan` is the shipped kill switch for the replacement progress_card tool.
  if (params.config?.tools?.updatePlan === false) {
    return false;
  }
  const deny = uniqueStrings([
    ...(params.config?.tools?.deny ?? []),
    ...(params.pluginToolDenylist ?? []),
  ]);
  if (
    !isToolAllowedByPolicyName("progress_card", {
      deny: expandShippedCoreToolPolicyNames(deny),
    }) ||
    !isRuntimeToolAllowed("progress_card", params.runtimeToolAllowlist)
  ) {
    return false;
  }
  const effective = resolveEffectiveToolPolicy({
    config: params.config,
    sessionKey: params.agentSessionKey,
    agentId: params.agentId,
    modelProvider: params.modelProvider,
    modelId: params.modelId,
  });
  const profilePolicy = mergeAlsoAllowPolicy(
    resolveToolProfilePolicy(effective.profile),
    effective.profileAlsoAllow,
  );
  const providerProfilePolicy = mergeAlsoAllowPolicy(
    resolveToolProfilePolicy(effective.providerProfile),
    effective.providerProfileAlsoAllow,
  );
  return isToolAllowedByPolicies(
    "progress_card",
    [
      profilePolicy,
      providerProfilePolicy,
      effective.globalPolicy,
      effective.globalProviderPolicy,
      effective.agentPolicy,
      effective.agentProviderPolicy,
    ].map(expandProgressCardPolicyNames),
  );
}

type PrimarySessionToolRegistrationParams = {
  config?: OpenClawConfig;
  agentSessionKey?: string;
  pluginToolDenylist?: string[];
};

function shouldIncludePrimarySessionToolForOpenClawTools(
  toolName: "ask_user" | "secrets",
  params: PrimarySessionToolRegistrationParams,
): boolean {
  const sessionKey = params.agentSessionKey?.trim();
  if (!sessionKey) {
    return false;
  }
  const deny = uniqueStrings([
    ...(params.config?.tools?.deny ?? []),
    ...(params.pluginToolDenylist ?? []),
  ]);
  return isPrimaryBootstrapRun(sessionKey) && isToolAllowedByPolicyName(toolName, { deny });
}

/** Includes ask_user only on a primary session and when normal deny policy permits it. */
export function shouldIncludeAskUserToolForOpenClawTools(
  params: PrimarySessionToolRegistrationParams,
): boolean {
  return shouldIncludePrimarySessionToolForOpenClawTools("ask_user", params);
}

/** Keeps credential management on primary sessions allowed by the normal tool policy. */
export function shouldIncludeSecretsToolForOpenClawTools(
  params: PrimarySessionToolRegistrationParams,
): boolean {
  return shouldIncludePrimarySessionToolForOpenClawTools("secrets", params);
}
