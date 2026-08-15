/**
 * Tool filesystem policy resolver.
 *
 * Combines global and agent fs/tool policy into workspace-only and root-expansion decisions.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ExecMode } from "../infra/exec-approvals.js";
import { resolveAgentConfig } from "./agent-scope.js";
import { pickSandboxToolPolicy } from "./sandbox-tool-policy.js";
import type { PreparedSessionPermissionPolicy, ToolFsPolicy } from "./tool-fs-policy.types.js";
import { isToolAllowedByPolicies } from "./tool-policy-match.js";
import { mergeAlsoAllowPolicy, resolveToolProfilePolicy } from "./tool-policy.js";

export type { PreparedSessionPermissionPolicy, ToolFsPolicy } from "./tool-fs-policy.types.js";

export function createToolFsPolicy(params: {
  workspaceOnly?: boolean;
  root?: string;
}): ToolFsPolicy {
  return {
    workspaceOnly: params.workspaceOnly === true,
    ...(params.root ? { root: params.root } : {}),
  };
}

export function resolveSessionPermissionExecMode(
  policy: PreparedSessionPermissionPolicy,
): ExecMode {
  switch (policy.mode) {
    case "read-only":
      return "deny";
    case "guarded":
      return "ask";
    case "workspace":
      return "auto";
    case "full":
      return "full";
  }
}

export function resolveToolFsConfig(params: { cfg?: OpenClawConfig; agentId?: string }): {
  workspaceOnly?: boolean;
} {
  const cfg = params.cfg;
  const globalFs = cfg?.tools?.fs;
  const agentFs =
    cfg && params.agentId ? resolveAgentConfig(cfg, params.agentId)?.tools?.fs : undefined;
  return {
    workspaceOnly: agentFs?.workspaceOnly ?? globalFs?.workspaceOnly,
  };
}

export function resolveEffectiveToolFsWorkspaceOnly(params: {
  cfg?: OpenClawConfig;
  agentId?: string;
}): boolean {
  return resolveToolFsConfig(params).workspaceOnly === true;
}

export function resolveEffectiveToolFsRootExpansionAllowed(params: {
  cfg?: OpenClawConfig;
  agentId?: string;
}): boolean {
  const cfg = params.cfg;
  if (!cfg) {
    return true;
  }
  const agentTools = params.agentId ? resolveAgentConfig(cfg, params.agentId)?.tools : undefined;
  const globalTools = cfg.tools;
  const profile = agentTools?.profile ?? globalTools?.profile;
  const profileAlsoAllow = new Set(agentTools?.alsoAllow ?? globalTools?.alsoAllow ?? []);
  const fsConfig = resolveToolFsConfig(params);
  if (fsConfig.workspaceOnly === true) {
    return false;
  }
  // tools.fs presence does not grant access; require profile or alsoAllow (#47487).
  const profilePolicy = mergeAlsoAllowPolicy(
    resolveToolProfilePolicy(profile),
    profileAlsoAllow.size > 0 ? Array.from(profileAlsoAllow) : undefined,
  );
  const globalPolicy = pickSandboxToolPolicy(globalTools);
  const agentPolicy = pickSandboxToolPolicy(agentTools);
  return isToolAllowedByPolicies("read", [profilePolicy, globalPolicy, agentPolicy]);
}
