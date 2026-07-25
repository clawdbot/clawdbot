import { createHash } from "node:crypto";
import { listAgentEntries } from "../agents/agent-scope.js";
import { stableStringify } from "../agents/stable-stringify.js";
import { getRuntimeConfig } from "../config/config.js";
import type { AgentConfig } from "../config/types.agents.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  AgentConfigPreconditionError,
  deleteAgentConfigEntry,
} from "../gateway/server-methods/agents-config-mutations.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  deletionEffects,
  type ClawCleanupTargets,
  type ClawTrashPath,
} from "./lifecycle-delete-support.js";

export type ConfigCommit = (transform: (config: OpenClawConfig) => OpenClawConfig) => Promise<void>;

export function digestClawAgentConfig(agent: AgentConfig): string {
  return `sha256:${createHash("sha256").update(stableStringify(agent)).digest("hex")}`;
}

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

export async function claimClawAgentConfigRemoval(params: {
  agentId: string;
  expectedDigest: string;
  expectedRemovalSurfaceDigest: string;
  expectedState: "present" | "missing";
  fallbackWorkspace: string;
  config?: OpenClawConfig;
  commitConfig?: ConfigCommit;
  trashPath?: ClawTrashPath;
  onModified: () => Error;
}): Promise<{
  agentRemoved: boolean;
  cleanupTargets?: ClawCleanupTargets;
  configBeforeDelete: OpenClawConfig;
  nextConfig: OpenClawConfig;
}> {
  if (params.commitConfig) {
    let result:
      | {
          agentRemoved: boolean;
          cleanupTargets?: ClawCleanupTargets;
          configBeforeDelete: OpenClawConfig;
          nextConfig: OpenClawConfig;
        }
      | undefined;
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
