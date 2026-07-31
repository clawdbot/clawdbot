/**
 * Spawned run metadata helpers.
 *
 * Projects tool runtime context into persisted lineage, group routing, workspace, and inherited policy metadata.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { resolveAgentWorkspaceDir } from "./agent-scope.js";

export type SpawnedRunMetadata = {
  spawnedBy?: string | null;
  groupId?: string | null;
  groupChannel?: string | null;
  groupSpace?: string | null;
  workspaceDir?: string | null;
};

export type SpawnedToolContext = {
  agentGroupId?: string | null;
  agentGroupChannel?: string | null;
  agentGroupSpace?: string | null;
  agentMemberRoleIds?: string[];
  workspaceDir?: string;
  inheritedToolAllowlist?: string[];
  inheritedToolDenylist?: string[];
};

type NormalizedSpawnedRunMetadata = {
  spawnedBy?: string;
  groupId?: string;
  groupChannel?: string;
  groupSpace?: string;
  workspaceDir?: string;
};

/** Normalize optional spawn metadata fields from persisted or tool-provided input. */
export function normalizeSpawnedRunMetadata(
  value?: SpawnedRunMetadata | null,
): NormalizedSpawnedRunMetadata {
  return {
    spawnedBy: normalizeOptionalString(value?.spawnedBy),
    groupId: normalizeOptionalString(value?.groupId),
    groupChannel: normalizeOptionalString(value?.groupChannel),
    groupSpace: normalizeOptionalString(value?.groupSpace),
    workspaceDir: normalizeOptionalString(value?.workspaceDir),
  };
}

/** Project tool runtime context down to the persisted spawned-run metadata shape. */
export function mapToolContextToSpawnedRunMetadata(
  value?: SpawnedToolContext | null,
): Pick<NormalizedSpawnedRunMetadata, "groupId" | "groupChannel" | "groupSpace" | "workspaceDir"> {
  return {
    groupId: normalizeOptionalString(value?.agentGroupId),
    groupChannel: normalizeOptionalString(value?.agentGroupChannel),
    groupSpace: normalizeOptionalString(value?.agentGroupSpace),
    workspaceDir: normalizeOptionalString(value?.workspaceDir),
  };
}

/** Resolve which workspace a spawned run should inherit. */
export function resolveSpawnedWorkspaceInheritance(params: {
  config: OpenClawConfig;
  targetAgentId?: string;
  requesterSessionKey?: string;
  explicitWorkspaceDir?: string | null;
}): string | undefined {
  const explicit = normalizeOptionalString(params.explicitWorkspaceDir);
  if (explicit) {
    return explicit;
  }
  // For cross-agent spawns, use the target agent's workspace instead of the requester's.
  const agentId =
    params.targetAgentId ??
    (params.requesterSessionKey
      ? parseAgentSessionKey(params.requesterSessionKey)?.agentId
      : undefined);
  return agentId ? resolveAgentWorkspaceDir(params.config, normalizeAgentId(agentId)) : undefined;
}

/** Resolve the persisted workspace used when a session re-enters an agent runtime. */
export function resolveIngressWorkspaceOverrideForSessionRun(
  metadata?:
    | (Pick<SpawnedRunMetadata, "spawnedBy" | "workspaceDir"> & {
        cwd?: string | null;
      })
    | null,
): string | undefined {
  const normalized = normalizeSpawnedRunMetadata(metadata);
  if (normalized.spawnedBy) {
    return normalized.workspaceDir;
  }
  // Dashboard worktree sessions are not subagents, so their managed cwd is
  // also the workspace that sandbox setup must mount on every later turn.
  return normalizeOptionalString(metadata?.cwd);
}
