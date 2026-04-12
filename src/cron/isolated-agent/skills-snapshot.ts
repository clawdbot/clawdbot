import { canExecRequestNode } from "../../agents/exec-defaults.js";
import type { SkillSnapshot } from "../../agents/skills.js";
import { matchesSkillFilter } from "../../agents/skills/filter.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  buildWorkspaceSkillSnapshot,
  getRemoteSkillEligibility,
  getSkillsSnapshotVersion,
  resolveAgentSkillsFilter,
} from "./run.runtime.js";

export function resolveCronSkillsSnapshot(params: {
  workspaceDir: string;
  config: OpenClawConfig;
  agentId: string;
  existingSnapshot?: SkillSnapshot;
  isFastTestEnv: boolean;
}): SkillSnapshot {
  if (params.isFastTestEnv) {
    // Fast unit-test mode skips filesystem scans and snapshot refresh writes.
    return params.existingSnapshot ?? { prompt: "", skills: [] };
  }

  const snapshotVersion = getSkillsSnapshotVersion(params.workspaceDir);
  const skillFilter = resolveAgentSkillsFilter(params.config, params.agentId);
  const existingSnapshot = params.existingSnapshot;
  const shouldRefresh =
    !existingSnapshot ||
    existingSnapshot.version !== snapshotVersion ||
    !matchesSkillFilter(existingSnapshot.skillFilter, skillFilter);
  if (!shouldRefresh) {
    return existingSnapshot;
  }

  return buildWorkspaceSkillSnapshot(params.workspaceDir, {
    config: params.config,
    agentId: params.agentId,
    skillFilter,
    eligibility: {
      remote: getRemoteSkillEligibility({
        advertiseExecNode: canExecRequestNode({
          cfg: params.config,
          agentId: params.agentId,
        }),
      }),
    },
    snapshotVersion,
  });
}
