/** Canonical projection from skill workshop config to system-owned cron jobs. */
import { canonicalizePath } from "../agents/utils/paths.js";
import { resolveAgentWorkspaceDirsById } from "../agents/workspace-dirs.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveHeartbeatPhaseMs,
  resolveHeartbeatSchedulerSeed,
} from "../infra/heartbeat-schedule.js";
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

export function resolveSkillCollectionReviewMonitorSpecs(
  cfg: OpenClawConfig,
  options: {
    schedulerSeed?: string;
    agentWorkspaceDirs?: ReadonlyMap<string, string>;
  } = {},
): Array<{ agentId: string; input: CronJobCreate }> {
  const workspaceAgents = new Map<string, string[]>();
  const agentWorkspaceDirs = options.agentWorkspaceDirs ?? resolveAgentWorkspaceDirsById(cfg);
  for (const [agentId, preparedWorkspaceDir] of agentWorkspaceDirs) {
    const workspaceDir = canonicalizePath(preparedWorkspaceDir);
    const agentIds = workspaceAgents.get(workspaceDir) ?? [];
    agentIds.push(agentId);
    workspaceAgents.set(workspaceDir, agentIds);
  }

  const schedulerSeed = resolveHeartbeatSchedulerSeed(options.schedulerSeed);
  const enabled = resolveSkillWorkshopConfig(cfg).autonomous.mode === "auto";
  return [...workspaceAgents.values()].flatMap((agentIds) => {
    const agentId = agentIds[0];
    if (!agentId) {
      return [];
    }
    return [
      {
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
          payload: { kind: "skillCollectionReview" },
          // Main is the only valid target for a no-turn system-owned payload; the timer invokes the runner directly.
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
        },
      },
    ];
  });
}
