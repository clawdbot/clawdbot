// Agent config mutation helpers wrap retrying config writes for create/update/
// delete flows and surface typed precondition failures to gateway handlers.
import { resolveAgentDir, resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import {
  applyAgentConfig,
  findAgentEntryIndex,
  listAgentEntries,
  pruneAgentConfig,
} from "../../commands/agents.config.js";
import { mutateConfigFileWithRetry } from "../../config/config.js";
import { resolveSessionTranscriptsDirForAgent } from "../../config/sessions.js";
import type { AgentConfig } from "../../config/types.agents.js";
import type { IdentityConfig } from "../../config/types.base.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

type AgentDeleteMutationResult = {
  workspaceDir: string;
  agentDir: string;
  sessionsDir: string;
  removedBindings: number;
};

/** Typed precondition failure surfaced by agent mutation handlers as gateway errors. */
export class AgentConfigPreconditionError extends Error {}

/** Checks the current config snapshot for a concrete agent entry. */
export function isConfiguredAgent(cfg: OpenClawConfig, agentId: string): boolean {
  return findAgentEntryIndex(listAgentEntries(cfg), agentId) >= 0;
}

/** Updates an existing agent entry while preserving omitted fields. */
export async function updateAgentConfigEntry(params: {
  agentId: string;
  name?: string;
  workspace?: string;
  model?: string | null;
  identity?: IdentityConfig;
}): Promise<void> {
  await mutateConfigFileWithRetry({
    afterWrite: { mode: "auto" },
    mutate: (draft) => {
      if (!isConfiguredAgent(draft, params.agentId)) {
        throw new AgentConfigPreconditionError(`agent "${params.agentId}" not found`);
      }
      const latestNextConfig = applyAgentConfig(draft, {
        agentId: params.agentId,
        ...(params.name ? { name: params.name } : {}),
        ...(params.workspace ? { workspace: params.workspace } : {}),
        ...(params.model !== undefined ? { model: params.model } : {}),
        ...(params.identity ? { identity: params.identity } : {}),
      });
      Object.assign(draft, latestNextConfig);
    },
  });
}

/** Removes an agent entry and returns filesystem roots the caller should clean up. */
export async function deleteAgentConfigEntry(params: {
  agentId: string;
  validate?: (agent: AgentConfig) => void;
  validateConfig?: (config: OpenClawConfig) => void;
  allowMissing?: boolean;
  fallbackWorkspace?: string;
}): Promise<{
  nextConfig: OpenClawConfig;
  result: AgentDeleteMutationResult | undefined;
}> {
  const committed = await mutateConfigFileWithRetry<AgentDeleteMutationResult | undefined>({
    afterWrite: { mode: "auto" },
    mutate: (draft) => {
      params.validateConfig?.(draft);
      const configured = isConfiguredAgent(draft, params.agentId);
      if (!configured && !params.allowMissing) {
        throw new AgentConfigPreconditionError(`agent "${params.agentId}" not found`);
      }
      const agent = listAgentEntries(draft).find((candidate) => candidate.id === params.agentId);
      if (agent) {
        params.validate?.(agent);
      }
      const workspaceDir = agent
        ? resolveAgentWorkspaceDir(draft, params.agentId)
        : (params.fallbackWorkspace ?? "");
      const agentDir = resolveAgentDir(draft, params.agentId);
      const sessionsDir = resolveSessionTranscriptsDirForAgent(params.agentId);
      const result = pruneAgentConfig(draft, params.agentId);
      Object.assign(draft, result.config);
      if (!agent) {
        return undefined;
      }
      return {
        workspaceDir,
        agentDir,
        sessionsDir,
        removedBindings: result.removedBindings,
      };
    },
  });
  return {
    nextConfig: committed.nextConfig,
    result: committed.result,
  };
}
