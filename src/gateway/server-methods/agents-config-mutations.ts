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
import type { IdentityConfig } from "../../config/types.base.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

type AgentDeleteMutationResult = {
  workspaceDir: string;
  agentDir: string;
  sessionsDir: string;
  removedBindings: number;
};

/** Typed precondition failure surfaced by agent mutation handlers as gateway errors. */
export class AgentConfigPreconditionError extends Error {
  constructor(
    readonly kind: "already-exists" | "not-found",
    readonly agentId: string,
  ) {
    super(
      kind === "already-exists"
        ? `agent "${agentId}" already exists`
        : `agent "${agentId}" not found`,
    );
    this.name = "AgentConfigPreconditionError";
  }
}

/** Checks the current config snapshot for a concrete agent entry. */
export function isConfiguredAgent(cfg: OpenClawConfig, agentId: string): boolean {
  return findAgentEntryIndex(listAgentEntries(cfg), agentId) >= 0;
}

/** Adds a new agent entry through the retrying config mutation path. */
export async function createAgentConfigEntry(params: {
  agentId: string;
  name: string;
  workspace: string;
  model?: string;
  identity?: IdentityConfig;
  agentDir: string;
}): Promise<void> {
  await mutateConfigFileWithRetry({
    afterWrite: { mode: "auto" },
    mutate: (draft) => {
      if (isConfiguredAgent(draft, params.agentId)) {
        throw new AgentConfigPreconditionError("already-exists", params.agentId);
      }
      const latestNextConfig = applyAgentConfig(draft, {
        agentId: params.agentId,
        name: params.name,
        workspace: params.workspace,
        model: params.model,
        identity: params.identity,
        agentDir: params.agentDir,
      });
      Object.assign(draft, latestNextConfig);
    },
  });
}

/** Updates an existing agent entry while preserving omitted fields. */
export async function updateAgentConfigEntry(params: {
  agentId: string;
  name?: string;
  workspace?: string;
  model?: string;
  identity?: IdentityConfig;
}): Promise<void> {
  await mutateConfigFileWithRetry({
    afterWrite: { mode: "auto" },
    mutate: (draft) => {
      if (!isConfiguredAgent(draft, params.agentId)) {
        throw new AgentConfigPreconditionError("not-found", params.agentId);
      }
      const latestNextConfig = applyAgentConfig(draft, {
        agentId: params.agentId,
        ...(params.name ? { name: params.name } : {}),
        ...(params.workspace ? { workspace: params.workspace } : {}),
        ...(params.model ? { model: params.model } : {}),
        ...(params.identity ? { identity: params.identity } : {}),
      });
      Object.assign(draft, latestNextConfig);
    },
  });
}

/** Removes an agent entry and returns filesystem roots the caller should clean up. */
export async function deleteAgentConfigEntry(params: { agentId: string }): Promise<{
  nextConfig: OpenClawConfig;
  result: AgentDeleteMutationResult | undefined;
}> {
  const committed = await mutateConfigFileWithRetry<AgentDeleteMutationResult>({
    afterWrite: { mode: "auto" },
    mutate: (draft) => {
      if (!isConfiguredAgent(draft, params.agentId)) {
        throw new AgentConfigPreconditionError("not-found", params.agentId);
      }
      const workspaceDir = resolveAgentWorkspaceDir(draft, params.agentId);
      const agentDir = resolveAgentDir(draft, params.agentId);
      const sessionsDir = resolveSessionTranscriptsDirForAgent(params.agentId);
      const result = pruneAgentConfig(draft, params.agentId);
      Object.assign(draft, result.config);
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
