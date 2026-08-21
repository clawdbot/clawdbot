/** Resolves the optional agent workspace enrichment used by plugin control-plane inventory. */
import {
  resolveAgentWorkspaceDir,
  tryResolveAmbientOwnerAgentId,
} from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginDiagnostic } from "./manifest-types.js";

const PLUGIN_WORKSPACE_SCOPE_OMITTED_DIAGNOSTIC_CODE = "workspace-scope-omitted" as const;

type PluginControlPlaneWorkspaceResolution = {
  agentId?: string;
  workspaceDir?: string;
  workspaceScope: "selected" | "omitted";
  diagnostic?: PluginDiagnostic;
};

/**
 * Resolve workspace discovery without inventing ownership for an explicit roster.
 * Shared roots remain safe to inspect when no system owner can be proven.
 */
export function resolvePluginControlPlaneWorkspace(params: {
  config: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): PluginControlPlaneWorkspaceResolution {
  if (params.workspaceDir !== undefined) {
    return { workspaceDir: params.workspaceDir, workspaceScope: "selected" };
  }
  const agentId = tryResolveAmbientOwnerAgentId(params.config);
  const workspaceDir = agentId
    ? resolveAgentWorkspaceDir(params.config, agentId, params.env)
    : undefined;
  if (workspaceDir) {
    return {
      agentId,
      workspaceDir,
      workspaceScope: "selected",
    };
  }
  return {
    workspaceScope: "omitted",
    diagnostic: {
      level: "warn",
      code: PLUGIN_WORKSPACE_SCOPE_OMITTED_DIAGNOSTIC_CODE,
      message:
        "Workspace plugin discovery was skipped because multiple explicit agents are configured without agents.defaults.systemAgent.agentId. " +
        "This partial result includes bundled, managed, and global plugins only; set agents.defaults.systemAgent.agentId to include that owner's workspace plugins.",
    },
  };
}
export function appendPluginControlPlaneWorkspaceDiagnostic(
  diagnostics: readonly PluginDiagnostic[],
  resolution: PluginControlPlaneWorkspaceResolution,
): PluginDiagnostic[] {
  const diagnostic = resolution.diagnostic;
  if (
    !diagnostic ||
    diagnostics.some((entry) => entry.code === PLUGIN_WORKSPACE_SCOPE_OMITTED_DIAGNOSTIC_CODE)
  ) {
    return [...diagnostics];
  }
  return [...diagnostics, diagnostic];
}
