// Cron doctor repair planning helpers for previewing and merging legacy rows.
import { isDeepStrictEqual } from "node:util";
import { normalizeOptionalStringifiedId } from "../../../../packages/normalization-core/src/string-coerce.js";
import { normalizeCronJobInput } from "../../../cron/normalize.js";
import type { CronJob } from "../../../cron/types.js";
import { resolveLegacyCronMigrationId } from "./legacy-store-migration.js";

type CronLegacyIssueCounts = Partial<Record<string, number>>;

function pluralize(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function formatJobNameList(names: string[]): string {
  const preview = names.slice(0, 5).map((name) => `\`${name}\``);
  const remaining = names.length - preview.length;
  return remaining > 0 ? `: ${preview.join(", ")} (+${remaining} more)` : `: ${preview.join(", ")}`;
}

/**
 * Advisory for isolated agentTurn cron jobs that describe a command but cannot access shell tools.
 * These need operator attention, but `doctor --fix` cannot safely infer whether to grant tool
 * access or recreate them as command cron jobs.
 */
export function formatUnresolvedCommandPromptAdvisory(names: string[]): string | null {
  if (names.length === 0) {
    return null;
  }
  const describeVerb = names.length === 1 ? "describes" : "describe";
  const accessVerb = names.length === 1 ? "lacks" : "lack";
  return [
    `${pluralize(names.length, "isolated cron job")} ${describeVerb} a shell command in the agent prompt but ${accessVerb} shell/process tool access${formatJobNameList(names)}.`,
    "- This is not the supported shell-tool prompt shape, so doctor cannot prove the job will execute the requested command.",
    '- Recreate the job as a command cron job (`openclaw cron add ... --command "<shell>"`) or grant explicit shell/process tool access before relying on it.',
  ].join("\n");
}

/**
 * Advisory for isolated agentTurn cron jobs that drive shell/process tools from the prompt.
 * These keep running and are not a legacy store row, so `doctor --fix` cannot rewrite them;
 * routing this through the auto-repair preview made the finding persist after every --fix.
 */
export function formatUnresolvedShellPromptAdvisory(names: string[]): string | null {
  if (names.length === 0) {
    return null;
  }
  const verb = names.length === 1 ? "drives" : "drive";
  const keepVerb = names.length === 1 ? "keeps" : "keep";
  return [
    `${pluralize(names.length, "isolated cron job")} ${verb} shell/process tools from the agent prompt and ${keepVerb} running as-is${formatJobNameList(names)}.`,
    "- This is a supported shape, not a legacy store row, so the doctor fix path cannot convert it and the finding is informational only.",
    '- For a deterministic run, recreate the job as a command cron job (`openclaw cron add ... --command "<shell>"`).',
  ].join("\n");
}

/** Advisory for jobs whose scheduled authority cannot be recovered without a caller decision. */
export function formatScheduledToolPolicyAdvisory(params: {
  legacyJobs: string[];
  invalidJobs: string[];
}): string | null {
  const lines: string[] = [];
  if (params.legacyJobs.length > 0) {
    lines.push(
      `${pluralize(params.legacyJobs.length, "tool-bearing cron job")} ${params.legacyJobs.length === 1 ? "keeps" : "keep"} legacy sender-policy resolution because stored account authority is not provable${formatJobNameList(params.legacyJobs)}.`,
    );
  }
  if (params.invalidJobs.length > 0) {
    lines.push(
      `${pluralize(params.invalidJobs.length, "tool-bearing cron job")} ${params.invalidJobs.length === 1 ? "has" : "have"} invalid or inconsistent scheduled authority provenance${formatJobNameList(params.invalidJobs)}.`,
    );
  }
  if (lines.length === 0) {
    return null;
  }
  lines.push(
    "- These jobs continue through restrictive sender-policy resolution; doctor will not infer authority from delivery or current configuration.",
    "- Reauthorize with `openclaw cron edit <id> --tools <tool,...>`, or use `--clear-tools` to adopt the current default cap.",
  );
  return lines.join("\n");
}

/** Convert legacy cron issue counts into doctor preview lines. */
export function formatLegacyIssuePreview(issues: CronLegacyIssueCounts): string[] {
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
  if (issues.migratedScheduledToolPolicy) {
    lines.push(
      `- ${pluralize(issues.migratedScheduledToolPolicy, "job")} can recover scheduled account authority from persisted owner identity`,
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
  return (
    normalizeOptionalStringifiedId(job.id) ??
    normalizeOptionalStringifiedId(job.jobId) ??
    resolveLegacyCronMigrationId(job)
  );
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
    "scheduledToolPolicy",
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
