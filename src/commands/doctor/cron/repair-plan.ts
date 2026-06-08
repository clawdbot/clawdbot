// Cron doctor repair planning helpers for previewing and merging legacy rows.
import { isDeepStrictEqual } from "node:util";
import { normalizeOptionalString } from "../../../../packages/normalization-core/src/string-coerce.js";
import { normalizeCronJobInput } from "../../../cron/normalize.js";
import type { CronJob } from "../../../cron/types.js";

export type CronLegacyIssueCounts = Partial<Record<string, number>>;
export type CronLegacyIssueDetails = {
  unresolvedAgentTurnShellToolPrompt?: string[];
};

function pluralize(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function formatJobNameList(names: string[] | undefined): string {
  if (!names || names.length === 0) {
    return "";
  }
  const preview = names.slice(0, 5).map((name) => `\`${name}\``);
  const remaining = names.length - preview.length;
  return remaining > 0 ? `: ${preview.join(", ")} (+${remaining} more)` : `: ${preview.join(", ")}`;
}

/** Convert legacy cron issue counts into doctor preview lines. */
export function formatLegacyIssuePreview(
  issues: CronLegacyIssueCounts,
  details: CronLegacyIssueDetails = {},
): string[] {
  const lines: string[] = [];
  if (issues.jobId) {
    lines.push(`- ${pluralize(issues.jobId, "job")} still uses legacy \`jobId\``);
  }
  if (issues.missingId) {
    lines.push(`- ${pluralize(issues.missingId, "job")} is missing a canonical string \`id\``);
  }
  if (issues.nonStringId) {
    lines.push(`- ${pluralize(issues.nonStringId, "job")} stores \`id\` as a non-string value`);
  }
  if (issues.legacyScheduleString) {
    lines.push(
      `- ${pluralize(issues.legacyScheduleString, "job")} stores schedule as a bare string`,
    );
  }
  if (issues.legacyScheduleCron) {
    lines.push(`- ${pluralize(issues.legacyScheduleCron, "job")} still uses \`schedule.cron\``);
  }
  if (issues.legacyPayloadKind) {
    lines.push(`- ${pluralize(issues.legacyPayloadKind, "job")} needs payload kind normalization`);
  }
  if (issues.legacyPayloadCodexModel) {
    lines.push(
      `- ${pluralize(issues.legacyPayloadCodexModel, "job")} still uses legacy \`openai-codex/*\` cron model refs`,
    );
  }
  if (issues.legacyAgentTurnCommandPayload) {
    lines.push(
      `- ${pluralize(issues.legacyAgentTurnCommandPayload, "job")} uses an agent prompt to run a shell command`,
    );
  }
  if (issues.unresolvedAgentTurnShellToolPrompt) {
    lines.push(
      `- ${pluralize(issues.unresolvedAgentTurnShellToolPrompt, "job")} asks an isolated agent for shell/process tools and needs manual command conversion${formatJobNameList(details.unresolvedAgentTurnShellToolPrompt)}`,
    );
  }
  if (issues.legacyPayloadProvider) {
    lines.push(
      `- ${pluralize(issues.legacyPayloadProvider, "job")} still uses payload \`provider\` as a delivery alias`,
    );
  }
  if (issues.legacyTopLevelPayloadFields) {
    lines.push(
      `- ${pluralize(issues.legacyTopLevelPayloadFields, "job")} still uses top-level payload fields`,
    );
  }
  if (issues.legacyTopLevelDeliveryFields) {
    lines.push(
      `- ${pluralize(issues.legacyTopLevelDeliveryFields, "job")} still uses top-level delivery fields`,
    );
  }
  if (issues.legacyDeliveryMode) {
    lines.push(
      `- ${pluralize(issues.legacyDeliveryMode, "job")} still uses delivery mode \`deliver\``,
    );
  }
  if (issues.invalidSchedule) {
    lines.push(
      `- ${pluralize(issues.invalidSchedule, "job")} has an invalid persisted schedule and will be removed`,
    );
  }
  if (issues.invalidPayload) {
    lines.push(
      `- ${pluralize(issues.invalidPayload, "job")} has an invalid persisted payload and will be removed`,
    );
  }
  return lines;
}

function cronJobMigrationKey(job: Record<string, unknown>): string | undefined {
  return normalizeOptionalString(job.id) ?? normalizeOptionalString(job.jobId);
}

/** Merge legacy JSON jobs into current jobs without duplicating matching ids/jobIds. */
export function mergeLegacyCronJobs(params: {
  currentJobs: Array<Record<string, unknown>>;
  legacyJobs: Array<Record<string, unknown>>;
}): { jobs: Array<Record<string, unknown>>; importedCount: number } {
  const merged = [...params.currentJobs];
  const currentKeys = new Set(
    params.currentJobs.map((job) => cronJobMigrationKey(job)).filter((key) => key !== undefined),
  );
  let importedCount = 0;

  for (const legacyJob of params.legacyJobs) {
    const key = cronJobMigrationKey(legacyJob);
    if (key && currentKeys.has(key)) {
      continue;
    }
    if (key) {
      currentKeys.add(key);
    }
    merged.push(legacyJob);
    importedCount += 1;
  }

  return { jobs: merged, importedCount };
}

/** Attach runtime SQLite state columns back onto a config-defined cron job row. */
export function mergeRuntimeEntryIntoConfigJob(params: {
  job: Record<string, unknown>;
  runtimeEntry?: { updatedAtMs?: number; state?: Record<string, unknown> };
}): Record<string, unknown> {
  return {
    ...params.job,
    ...(params.runtimeEntry?.updatedAtMs !== undefined
      ? { updatedAtMs: params.runtimeEntry.updatedAtMs }
      : {}),
    ...(params.runtimeEntry?.state ? { state: structuredClone(params.runtimeEntry.state) } : {}),
  };
}

/** Return true when a SQLite cron projection row no longer matches config JSON. */
export function needsSqliteProjectionBackfill(params: {
  configJob: Record<string, unknown>;
  projectedJob?: CronJob;
}): boolean {
  if (!params.projectedJob) {
    return true;
  }
  const normalizedConfig = normalizeCronJobInput(params.configJob, { applyDefaults: true });
  if (!normalizedConfig) {
    return true;
  }
  const projected = params.projectedJob as unknown as Record<string, unknown>;
  for (const field of [
    "agentId",
    "deleteAfterRun",
    "delivery",
    "description",
    "enabled",
    "failureAlert",
    "name",
    "payload",
    "schedule",
    "sessionKey",
    "sessionTarget",
    "wakeMode",
  ] as const) {
    if (!isDeepStrictEqual(normalizedConfig[field], projected[field])) {
      return true;
    }
  }
  return false;
}
