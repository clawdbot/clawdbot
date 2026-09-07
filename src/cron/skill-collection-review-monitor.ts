/** Canonical projection from skill workshop config to system-owned cron jobs. */
import { listAgentIds } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveHeartbeatSchedulerSeed } from "../infra/heartbeat-runner.js";
import { resolveHeartbeatPhaseMs } from "../infra/heartbeat-schedule.js";
import { resolveSkillWorkshopConfig } from "../skills/workshop/config.js";
import {
  SKILL_WORKSHOP_MAINTENANCE_PROMPT,
  SKILL_WORKSHOP_MAINTENANCE_TOOLS,
} from "../skills/workshop/maintenance-prompt.js";
import { SKILL_COLLECTION_REVIEW_DECLARATION_PREFIX } from "./system-owned-declaration.js";
import type { CronJob, CronJobCreate } from "./types.js";

const SKILL_COLLECTION_REVIEW_EVERY_MS = 7 * 24 * 60 * 60_000;

export function skillCollectionReviewMonitorAgentId(job: CronJob): string | undefined {
  const key = job.declarationKey;
  if (!key?.startsWith(SKILL_COLLECTION_REVIEW_DECLARATION_PREFIX)) {
    return undefined;
  }
  return key.slice(SKILL_COLLECTION_REVIEW_DECLARATION_PREFIX.length) || undefined;
}

/** One system-owned review job per configured agent and its Workshop directory. */
export function resolveSkillCollectionReviewMonitorSpecs(
  cfg: OpenClawConfig,
  options: { schedulerSeed?: string } = {},
): Array<{ agentId: string; input: CronJobCreate }> {
  const schedulerSeed = resolveHeartbeatSchedulerSeed(options.schedulerSeed);
  const enabled = resolveSkillWorkshopConfig(cfg).autonomous.mode === "auto";
  return listAgentIds(cfg).map((agentId) => ({
    agentId,
    input: {
      declarationKey: `${SKILL_COLLECTION_REVIEW_DECLARATION_PREFIX}${agentId}`,
      name: `skill-collection-review-${agentId}`,
      displayName: `Skill collection review (${agentId})`,
      agentId,
      enabled,
      schedule: {
        kind: "every",
        everyMs: SKILL_COLLECTION_REVIEW_EVERY_MS,
        anchorMs: resolveHeartbeatPhaseMs({
          schedulerSeed,
          agentId,
          intervalMs: SKILL_COLLECTION_REVIEW_EVERY_MS,
        }),
      },
      payload: {
        kind: "agentTurn",
        message: SKILL_WORKSHOP_MAINTENANCE_PROMPT,
        toolsAllow: [...SKILL_WORKSHOP_MAINTENANCE_TOOLS],
      },
      sessionTarget: "isolated",
      delivery: { mode: "none" },
      wakeMode: "next-heartbeat",
    },
  }));
}
