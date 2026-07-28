// Cron snapshot helpers collect runtime skill state for scheduled agents.
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import type { SkillSnapshot } from "../types.js";

const skillsSnapshotRuntimeLoader = createLazyImportLoader(
  () => import("./cron-snapshot.runtime.js"),
);

async function loadSkillsSnapshotRuntime() {
  return await skillsSnapshotRuntimeLoader.load();
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
  const skillFilter = runtime.resolveEffectiveAgentSkillFilter(params.config, params.agentId);
  const nodeSkills = runtime.resolveNodeExecEligibility({
    cfg: params.config,
    agentId: params.agentId,
  });
  return runtime.resolveReusableWorkspaceSkillSnapshot({
    workspaceDir: params.workspaceDir,
    config: params.config,
    agentId: params.agentId,
    existingSnapshot: params.existingSnapshot,
    skillFilter,
    eligibility: {
      nodeSkills,
      remote: runtime.getRemoteSkillEligibility({
        advertiseExecNode: nodeSkills.canExec,
      }),
    },
    watch: false,
    hydrateExisting: false,
  }).snapshot;
}
