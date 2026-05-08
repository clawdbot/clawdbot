import { pickSandboxToolPolicy } from "../agents/sandbox-tool-policy.js";
import { resolveSandboxConfigForAgent } from "../agents/sandbox/config.js";
import { resolveSandboxToolPolicyForAgent } from "../agents/sandbox/tool-policy.js";
import type { SandboxToolPolicy } from "../agents/sandbox/types.js";
import { isToolAllowedByPolicies } from "../agents/tool-policy-match.js";
import { resolveToolProfilePolicy } from "../agents/tool-policy.js";
import type { OpenClawConfig } from "../config/config.js";
import type { AgentToolsConfig, ExecToolConfig } from "../config/types.tools.js";

const MUTATING_FS_TOOLS = ["write", "edit", "apply_patch"] as const;
const RUNTIME_TOOLS = ["exec", "process"] as const;

export type ExecFilesystemPolicyDriftHit = {
  scopeLabel: string;
  runtimeTools: string[];
  disabledFilesystemTools: string[];
  sandboxMode: "off" | "non-main" | "all";
  sandboxWorkspaceAccess: "none" | "ro" | "rw";
  execHost: NonNullable<ExecToolConfig["host"]>;
};

function resolveToolPolicies(params: {
  cfg: OpenClawConfig;
  agentTools?: AgentToolsConfig;
  sandboxMode: "off" | "non-main" | "all";
  agentId?: string;
}): SandboxToolPolicy[] {
  const policies: SandboxToolPolicy[] = [];
  const profile = params.agentTools?.profile ?? params.cfg.tools?.profile;
  const profilePolicy = resolveToolProfilePolicy(profile);
  if (profilePolicy) {
    policies.push(profilePolicy);
  }

  const globalPolicy = pickSandboxToolPolicy(params.cfg.tools ?? undefined);
  if (globalPolicy) {
    policies.push(globalPolicy);
  }

  const agentPolicy = pickSandboxToolPolicy(params.agentTools);
  if (agentPolicy) {
    policies.push(agentPolicy);
  }

  if (params.sandboxMode === "all") {
    policies.push(resolveSandboxToolPolicyForAgent(params.cfg, params.agentId));
  }

  return policies;
}

function resolveExecHost(params: {
  globalExec?: ExecToolConfig;
  agentExec?: ExecToolConfig;
}): NonNullable<ExecToolConfig["host"]> {
  return params.agentExec?.host ?? params.globalExec?.host ?? "auto";
}

function isExecFilesystemConstrained(params: {
  sandboxMode: "off" | "non-main" | "all";
  sandboxWorkspaceAccess: "none" | "ro" | "rw";
  execHost: NonNullable<ExecToolConfig["host"]>;
}): boolean {
  if (params.sandboxMode !== "all") {
    return false;
  }
  if (params.execHost === "gateway" || params.execHost === "node") {
    return false;
  }
  return params.sandboxWorkspaceAccess !== "rw";
}

export function collectExecFilesystemPolicyDriftHits(
  cfg: OpenClawConfig,
): ExecFilesystemPolicyDriftHit[] {
  const hits: ExecFilesystemPolicyDriftHit[] = [];
  const globalExec = cfg.tools?.exec;
  const contexts: Array<{
    scopeLabel: string;
    agentId?: string;
    tools?: AgentToolsConfig;
  }> = [{ scopeLabel: "tools" }];

  for (const agent of cfg.agents?.list ?? []) {
    if (!agent || typeof agent !== "object" || typeof agent.id !== "string") {
      continue;
    }
    contexts.push({
      scopeLabel: `agents.list.${agent.id}.tools`,
      agentId: agent.id,
      tools: agent.tools,
    });
  }

  for (const context of contexts) {
    const sandbox = resolveSandboxConfigForAgent(cfg, context.agentId);
    const execHost = resolveExecHost({
      globalExec,
      agentExec: context.tools?.exec,
    });
    if (
      isExecFilesystemConstrained({
        sandboxMode: sandbox.mode,
        sandboxWorkspaceAccess: sandbox.workspaceAccess,
        execHost,
      })
    ) {
      continue;
    }

    const policies = resolveToolPolicies({
      cfg,
      agentTools: context.tools,
      sandboxMode: sandbox.mode,
      agentId: context.agentId,
    });
    const runtimeTools = RUNTIME_TOOLS.filter((tool) => isToolAllowedByPolicies(tool, policies));
    if (!runtimeTools.includes("exec")) {
      continue;
    }

    const disabledFilesystemTools = MUTATING_FS_TOOLS.filter(
      (tool) => !isToolAllowedByPolicies(tool, policies),
    );
    if (disabledFilesystemTools.length !== MUTATING_FS_TOOLS.length) {
      continue;
    }

    hits.push({
      scopeLabel: context.scopeLabel,
      runtimeTools,
      disabledFilesystemTools,
      sandboxMode: sandbox.mode,
      sandboxWorkspaceAccess: sandbox.workspaceAccess,
      execHost,
    });
  }

  return hits;
}
