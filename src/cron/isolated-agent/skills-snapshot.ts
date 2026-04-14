import type { SkillSnapshot } from "../../agents/skills.js";
import { matchesSkillFilter } from "../../agents/skills/filter.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

let skillsSnapshotRuntimePromise:
  | Promise<typeof import("./skills-snapshot.runtime.js")>
  | undefined;

async function loadSkillsSnapshotRuntime() {
  skillsSnapshotRuntimePromise ??= import("./skills-snapshot.runtime.js");
  return await skillsSnapshotRuntimePromise;
}

export async function resolveCronSkillsSnapshot(params: {
  workspaceDir: string;
  config: OpenClawConfig;
  agentId: string;
  existingSnapshot?: SkillSnapshot;
  isFastTestEnv: boolean;
}): Promise<SkillSnapshot> {
  if (params.isFastTestEnv) {
    // Fast unit-test mode skips filesystem scans and snapshot refresh writes.
    return params.existingSnapshot ?? { prompt: "", skills: [] };
  }

  const runtime = await loadSkillsSnapshotRuntime();
  const snapshotVersion = runtime.getSkillsSnapshotVersion(params.workspaceDir);
  const skillFilter = runtime.resolveAgentSkillsFilter(params.config, params.agentId);
  const existingSnapshot = params.existingSnapshot;
  const shouldRefresh =
    !existingSnapshot ||
    existingSnapshot.version !== snapshotVersion ||
    !matchesSkillFilter(existingSnapshot.skillFilter, skillFilter);
  if (!shouldRefresh) {
    return existingSnapshot;
  }

  return runtime.buildWorkspaceSkillSnapshot(params.workspaceDir, {
    config: params.config,
    agentId: params.agentId,
    skillFilter,
    eligibility: {
      remote: runtime.getRemoteSkillEligibility({
        advertiseExecNode: runtime.canExecRequestNode({
          cfg: params.config,
          agentId: params.agentId,
        }),
      }),
    },
    snapshotVersion,
  });
}
