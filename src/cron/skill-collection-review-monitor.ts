/** Canonical projection from skill workshop config to system-owned cron jobs. */
import { listAgentIds, tryResolveAmbientOwnerAgentId } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveHeartbeatSchedulerSeed } from "../infra/heartbeat-runner.js";
import { resolveHeartbeatPhaseMs } from "../infra/heartbeat-schedule.js";
import { resolveSkillWorkshopConfig } from "../skills/workshop/config.js";
import type { CronJob, CronJobCreate } from "./types.js";

export const SKILL_COLLECTION_REVIEW_DECLARATION_PREFIX = "skill-collection-review:";
const SKILL_COLLECTION_REVIEW_EVERY_MS = 7 * 24 * 60 * 60_000;

export function skillCollectionReviewMonitorAgentId(job: CronJob): string | undefined {
  const key = job.declarationKey;
  if (
    !key?.startsWith(SKILL_COLLECTION_REVIEW_DECLARATION_PREFIX) ||
    job.payload.kind !== "skillCollectionReview"
  ) {
    return undefined;
  }
  return key.slice(SKILL_COLLECTION_REVIEW_DECLARATION_PREFIX.length) || undefined;
}

/**
 * One job, because the Workshop owns one global skill collection; a second job would only
 * contend for the same review lease. The owner is a scheduler identity, not a workspace: the
 * review never touches agent workspaces, so an explicit fleet without a system agent falls
 * back to its first configured agent instead of failing cron startup.
 */
export function resolveSkillCollectionReviewMonitorSpecs(
  cfg: OpenClawConfig,
  options: { schedulerSeed?: string } = {},
): Array<{ agentId: string; input: CronJobCreate }> {
  const agentId = tryResolveAmbientOwnerAgentId(cfg) ?? listAgentIds(cfg)[0];
  if (!agentId) {
    return [];
  }
  const schedulerSeed = resolveHeartbeatSchedulerSeed(options.schedulerSeed);
  return [
    {
      agentId,
      input: {
        declarationKey: `${SKILL_COLLECTION_REVIEW_DECLARATION_PREFIX}${agentId}`,
        name: `skill-collection-review-${agentId}`,
        displayName: `Skill collection review (${agentId})`,
        agentId,
        enabled: resolveSkillWorkshopConfig(cfg).autonomous.mode === "auto",
        schedule: {
          kind: "every",
          everyMs: SKILL_COLLECTION_REVIEW_EVERY_MS,
          anchorMs: resolveHeartbeatPhaseMs({
            schedulerSeed,
            agentId,
            intervalMs: SKILL_COLLECTION_REVIEW_EVERY_MS,
          }),
        },
        payload: { kind: "skillCollectionReview" },
        // Main is the only valid target for a no-turn system-owned payload; the timer invokes the runner directly.
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
      },
    },
  ];
}
