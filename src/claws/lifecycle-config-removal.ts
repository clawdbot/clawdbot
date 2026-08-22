import { createHash } from "node:crypto";
import { stableStringify } from "@openclaw/normalization-core";
import { beginAgentDeletion } from "../agents/agent-lifecycle-registry.js";
import { listAgentEntries } from "../agents/agent-scope.js";
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  AgentConfigPreconditionError,
  deleteAgentConfigEntry,
} from "../gateway/server-methods/agents-config-mutations.js";
import { withAgentExecApprovalsRemoved } from "../infra/exec-approvals.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { readAgentDeletionJournal } from "../state/agent-deletion-journal.js";
import { digestClawAgentConfig } from "./agent-config-digest.js";
import {
  deletionEffects,
  type ClawCleanupTargets,
  type ClawTrashPath,
} from "./lifecycle-delete-support.js";

export type ConfigCommit = (transform: (config: OpenClawConfig) => OpenClawConfig) => Promise<void>;

type ClawAgentConfigRemovalParams = {
  agentId: string;
  expectedDigest: string;
  expectedRemovalSurfaceDigest: string;
  expectedState: "present" | "missing";
  fallbackWorkspace: string;
  config?: OpenClawConfig;
  commitConfig?: ConfigCommit;
  trashPath?: ClawTrashPath;
  onModified: () => Error;
};

type ClawAgentConfigRemovalResult = {
  agentRemoved: boolean;
  cleanupTargets?: ClawCleanupTargets;
  configBeforeDelete: OpenClawConfig;
  nextConfig: OpenClawConfig;
};

export { digestClawAgentConfig } from "./agent-config-digest.js";

export function digestClawAgentRemovalSurface(config: OpenClawConfig, agentId: string): string {
  const normalizedId = normalizeAgentId(agentId);
  const surface = {
    bindings: (config.bindings ?? []).filter(
      (binding) => normalizeAgentId(binding.agentId) === normalizedId,
    ),
    agentToAgentAllow: (config.tools?.agentToAgent?.allow ?? []).filter(
      (entry) => entry === normalizedId,
    ),
  };
  return `sha256:${createHash("sha256").update(stableStringify(surface)).digest("hex")}`;
}

async function commitClawAgentConfigRemoval(
  params: ClawAgentConfigRemovalParams,
): Promise<ClawAgentConfigRemovalResult> {
  if (params.commitConfig) {
    let result: ClawAgentConfigRemovalResult | undefined;
    await params.commitConfig((config) => {
      const effects = deletionEffects(config, params.agentId, params.fallbackWorkspace);
      const agent = listAgentEntries(config).find((candidate) => candidate.id === params.agentId);
      if (
        (agent && digestClawAgentConfig(agent) !== params.expectedDigest) ||
        digestClawAgentRemovalSurface(config, params.agentId) !==
          params.expectedRemovalSurfaceDigest
      ) {
        throw params.onModified();
      }
      result = {
        agentRemoved: Boolean(agent),
        ...(params.trashPath
          ? {
              cleanupTargets: {
                workspaceDir: effects.workspace,
                agentDir: effects.agentDir,
                sessionsDir: effects.sessionsDir,
              },
            }
          : {}),
        configBeforeDelete: config,
        nextConfig: effects.pruned.config,
      };
      return effects.pruned.config;
    });
    if (!result) {
      throw new Error("Claw config removal did not run its commit transform.");
    }
    return result;
  }

  const configBeforeDelete = params.config ?? getRuntimeConfig();
  try {
    const committed = await deleteAgentConfigEntry({
      agentId: params.agentId,
      allowConfigSizeDrop: true,
      allowMissing: params.expectedState === "missing",
      fallbackWorkspace: params.fallbackWorkspace,
      validateConfig: (config) => {
        if (
          digestClawAgentRemovalSurface(config, params.agentId) !==
          params.expectedRemovalSurfaceDigest
        ) {
          throw params.onModified();
        }
      },
      validate: (agent) => {
        if (params.expectedState === "missing") {
          throw params.onModified();
        }
        if (digestClawAgentConfig(agent) !== params.expectedDigest) {
          throw params.onModified();
        }
      },
    });
    const fallbackEffects = deletionEffects(
      configBeforeDelete,
      params.agentId,
      params.fallbackWorkspace,
    );
    return {
      agentRemoved: Boolean(committed.result),
      cleanupTargets: committed.result ?? {
        workspaceDir: fallbackEffects.workspace,
        agentDir: fallbackEffects.agentDir,
        sessionsDir: fallbackEffects.sessionsDir,
      },
      configBeforeDelete,
      nextConfig: committed.nextConfig,
    };
  } catch (error) {
    if (!(error instanceof AgentConfigPreconditionError)) {
      throw error;
    }
    const latestConfig = getRuntimeConfig();
    if (listAgentEntries(latestConfig).some((agent) => agent.id === params.agentId)) {
      throw params.onModified();
    }
    const effects = deletionEffects(latestConfig, params.agentId, params.fallbackWorkspace);
    return {
      agentRemoved: false,
      cleanupTargets: {
        workspaceDir: effects.workspace,
        agentDir: effects.agentDir,
        sessionsDir: effects.sessionsDir,
      },
      configBeforeDelete,
      nextConfig: latestConfig,
    };
  }
}

export async function claimClawAgentConfigRemoval(params: ClawAgentConfigRemovalParams) {
  const config = params.config ?? getRuntimeConfig();
  const effects = deletionEffects(config, params.agentId, params.fallbackWorkspace);
  // beginAgentDeletion takes over an existing journal row instead of refusing it, so rolling back
  // a row this call did not open would erase another deletion's record.
  const existingJournal = readAgentDeletionJournal(params.agentId);
  const deletion = beginAgentDeletion({
    agentId: params.agentId,
    workspaceDir: effects.workspace,
    agentDir: effects.agentDir,
    sessionsDir: effects.sessionsDir,
    // Claw removal owns selective cleanup and may retain modified or untracked workspace entries,
    // so the journal must not claim authority to trash them.
    deleteFiles: existingJournal?.deleteFiles ?? false,
  });
  try {
    const result = await withAgentExecApprovalsRemoved(params.agentId, async () =>
      commitClawAgentConfigRemoval({ ...params, config }),
    );
    deletion.commit();
    // The journal fences only the roster and approvals commit here; Claw's own filesystem cleanup
    // runs afterwards and may legitimately end partial, so completion is recorded now.
    deletion.finish();
    return result;
  } catch (error) {
    if (!existingJournal) {
      deletion.rollback();
    }
    throw error;
  }
}
