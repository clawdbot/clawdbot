// Doctor cron repair orchestration for legacy stores, run logs, payloads, and warnings.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { note } from "../../../../packages/terminal-core/src/note.js";
import { resolveStaticSessionMcpServerNames } from "../../../agents/agent-bundle-mcp-runtime-config.js";
import {
  resolveAgentWorkspaceDir,
  tryResolveAmbientOwnerAgentId,
} from "../../../agents/agent-scope.js";
import { resolveCodexMcpToolOverridesForAgent } from "../../../agents/cli-runner/bundle-mcp-codex.js";
import { formatCliCommand } from "../../../cli/command-format.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { loadCronQuarantinedJobs, resolveCronJobsStorePath } from "../../../cron/store.js";
import type { HealthFinding } from "../../../flows/health-checks.js";
import { formatErrorMessage as errorMessage } from "../../../infra/errors.js";
import { resolveOpenClawStateSqlitePath } from "../../../state/openclaw-state-db.paths.js";
import { shortenHomePath } from "../../../utils.js";
import type { DoctorPrompter, DoctorOptions } from "../../doctor-prompter.js";
import { countStaleDreamingJobs } from "./dreaming-payload-migration.js";
import {
  applyLegacyCronStoreRepair,
  loadLegacyCronRepairState,
  type LegacyCronRepairResult,
  type LegacyCronRepairState,
} from "./legacy-repair.js";
import {
  formatLegacyIssuePreview,
  formatIncompleteInheritedAuthorityAdvisory,
  formatScheduledToolPolicyAdvisory,
  formatUnresolvedCommandPromptAdvisory,
  formatUnresolvedShellPromptAdvisory,
} from "./repair-plan.js";
import { normalizeStoredCronJobs } from "./store-migration.js";
import { noteCronDeliveryTargetAdvisory, noteCronModelOverrides } from "./warnings.js";

export {
  collectLegacyWhatsAppCrontabHealthWarning,
  noteLegacyWhatsAppCrontabHealthCheck,
} from "./warnings.js";

function pluralize(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function readLegacyCronStorePath(cfg: OpenClawConfig): string | undefined {
  return (cfg.cron as (NonNullable<OpenClawConfig["cron"]> & { store?: string }) | undefined)
    ?.store;
}

// Count jobs the store still marks in-flight (`state.runningAtMs` is a number).
// The scheduler sets this while a run is active and clears it on completion, so a
// leftover marker (gateway killed mid-run) makes `cron list` show the job as
// `running` while nothing executes it. Startup marks exactly these runs interrupted
// (`src/cron/service/ops-lifecycle.ts` `start`), so doctor only reports the count here.
function countInFlightCronJobs(jobs: Array<Record<string, unknown>>): number {
  return jobs.filter((job) => {
    const state = job.state;
    return (
      typeof state === "object" &&
      state !== null &&
      typeof (state as { runningAtMs?: unknown }).runningAtMs === "number"
    );
  }).length;
}

// Fixed advisory threshold: three failures in a row is a clear chronic signal on
// its own. It coincides with the scheduler's built-in transient-retry budget, but
// doctor deliberately does not mirror retry exhaustion semantics.
const CHRONIC_FAILURE_MIN_CONSECUTIVE_ERRORS = 3;

// Count enabled jobs stuck in repeated run failures. `state.consecutiveErrors`
// resets to 0 on the next successful run and also increments for runs interrupted
// by a gateway restart (startup marks in-flight runs failed, `src/cron/service/ops-lifecycle.ts`),
// so a streak can mean task failures, interrupted runs, or a mix — the note says so.
// Failure alerts are opt-in, so by default nothing else surfaces the streak.
// Disabled jobs no longer re-fire (e.g. the scheduler disables exhausted
// one-shot jobs with their error state retained), so they are excluded.
function countChronicallyFailingCronJobs(jobs: Array<Record<string, unknown>>): number {
  return jobs.filter((job) => {
    // Missing `enabled` counts as enabled, matching `isJobEnabled`
    // (`src/cron/service/jobs.ts`); only an explicit `false` is excluded.
    if (job.enabled === false) {
      return false;
    }
    const state = job.state;
    if (typeof state !== "object" || state === null) {
      return false;
    }
    const consecutiveErrors = (state as { consecutiveErrors?: unknown }).consecutiveErrors;
    return (
      typeof consecutiveErrors === "number" &&
      consecutiveErrors >= CHRONIC_FAILURE_MIN_CONSECUTIVE_ERRORS
    );
  }).length;
}

type AutoDisabledCronJob = {
  id: string;
  name: string;
  reason: "consecutive-failures" | "schedule-errors";
  consecutiveErrors: number;
};

function collectAutoDisabledCronJobs(jobs: Array<Record<string, unknown>>): AutoDisabledCronJob[] {
  const autoDisabledJobs: AutoDisabledCronJob[] = [];
  for (const job of jobs) {
    if (job.enabled !== false || typeof job.id !== "string") {
      continue;
    }
    const state = job.state;
    if (!isRecord(state)) {
      continue;
    }
    const autoDisabled = state.autoDisabled;
    if (!isRecord(autoDisabled)) {
      continue;
    }
    if (
      (autoDisabled.reason !== "consecutive-failures" &&
        autoDisabled.reason !== "schedule-errors") ||
      typeof autoDisabled.consecutiveErrors !== "number"
    ) {
      continue;
    }
    autoDisabledJobs.push({
      id: job.id,
      name: typeof job.name === "string" && job.name.trim() ? job.name.trim() : job.id,
      reason: autoDisabled.reason,
      consecutiveErrors: autoDisabled.consecutiveErrors,
    });
  }
  return autoDisabledJobs;
}

const LEGACY_CRON_STORE_CHECK_ID = "core/doctor/legacy-cron-store";

function legacyCronStoreFinding(params: {
  readonly message: string;
  readonly path: string;
  readonly requirement: string;
  readonly fixHint?: string;
}): HealthFinding {
  return {
    checkId: LEGACY_CRON_STORE_CHECK_ID,
    severity: "warning",
    message: params.message,
    path: params.path,
    requirement: params.requirement,
    fixHint:
      params.fixHint ??
      `Run ${formatCliCommand("openclaw doctor --fix")} to normalize legacy cron storage.`,
  };
}

export async function collectLegacyCronStoreHealthFindings(params: {
  cfg: OpenClawConfig;
}): Promise<readonly HealthFinding[]> {
  let state: LegacyCronRepairState | null;
  try {
    state = await loadLegacyCronRepairState({ cfg: params.cfg, readOnly: true });
  } catch (err) {
    const storePath = resolveCronJobsStorePath(readLegacyCronStorePath(params.cfg));
    return [
      legacyCronStoreFinding({
        message: `Unable to read cron job store at ${shortenHomePath(storePath)}.`,
        path: storePath,
        requirement: "cron-store-readable",
        fixHint: [
          `Fix the file's permissions or contents and re-run ${formatCliCommand("openclaw doctor")}.`,
          "Later health checks will continue.",
          `Details: ${errorMessage(err)}`,
        ].join(" "),
      }),
    ];
  }
  if (!state) {
    return [];
  }

  const findings: HealthFinding[] = [];
  const {
    storePath,
    legacyStoreDetected,
    legacyRunLogDetected,
    legacyQuarantine,
    legacyImportCount,
    sqliteProjectionBackfillCount,
    rawJobs,
  } = state;
  const sqliteStorePath = resolveOpenClawStateSqlitePath();

  try {
    const quarantine = loadCronQuarantinedJobs(storePath);
    if (quarantine.length > 0) {
      findings.push(
        legacyCronStoreFinding({
          message: `${pluralize(quarantine.length, "quarantined cron job row")} found in SQLite at ${shortenHomePath(sqliteStorePath)}.`,
          path: sqliteStorePath,
          requirement: "quarantined-cron-rows",
          fixHint:
            "Review or repair quarantined rows before restoring any job to the active cron store.",
        }),
      );
    }
  } catch (err) {
    findings.push(
      legacyCronStoreFinding({
        message: `Unable to read quarantined cron rows in SQLite at ${shortenHomePath(sqliteStorePath)}.`,
        path: sqliteStorePath,
        requirement: "cron-quarantine-readable",
        fixHint: `Check the shared state database permissions and contents. Details: ${errorMessage(err)}`,
      }),
    );
  }

  if (legacyQuarantine) {
    findings.push(
      legacyCronStoreFinding({
        message: `Legacy JSON cron quarantine will be imported into SQLite from ${shortenHomePath(legacyQuarantine.path)}.`,
        path: legacyQuarantine.path,
        requirement: "legacy-cron-quarantine",
      }),
    );
  }

  if (legacyStoreDetected) {
    findings.push(
      legacyCronStoreFinding({
        message:
          legacyImportCount > 0
            ? `${pluralize(legacyImportCount, "legacy JSON cron job")} will be imported into SQLite.`
            : `Legacy JSON cron store was found at ${shortenHomePath(storePath)}.`,
        path: storePath,
        requirement: "legacy-cron-store",
      }),
    );
  }
  if (legacyRunLogDetected) {
    findings.push(
      legacyCronStoreFinding({
        message: `Legacy JSON cron run logs will be imported into SQLite for ${shortenHomePath(storePath)}.`,
        path: storePath,
        requirement: "legacy-cron-run-logs",
      }),
    );
  }

  if (rawJobs.length === 0) {
    return findings;
  }

  const normalized = normalizeStoredCronJobs(rawJobs);
  for (const line of formatLegacyIssuePreview(normalized.issues)) {
    findings.push(
      legacyCronStoreFinding({
        message: line.replace(/^- /u, ""),
        path: sqliteStorePath,
        requirement: "legacy-cron-store-shape",
      }),
    );
  }
  for (const job of normalized.legacyTriggerScriptJobs) {
    findings.push(
      legacyCronStoreFinding({
        message: `Legacy cron trigger script for ${job} can be migrated to canonical direct tool calls.`,
        path: sqliteStorePath,
        requirement: "legacy-cron-trigger-script",
      }),
    );
  }
  for (const job of normalized.unsupportedLegacyTriggerScriptJobs) {
    findings.push(
      legacyCronStoreFinding({
        message: `Legacy cron trigger script for ${job} cannot be safely migrated automatically.`,
        path: sqliteStorePath,
        requirement: "unsupported-legacy-cron-trigger-script",
        fixHint:
          "Inspect the automation and update its trigger script manually to use direct tool calls.",
      }),
    );
  }
  for (const [names, requirement, description] of [
    [
      normalized.legacyScheduledToolPolicyJobs,
      "cron-scheduled-authority-reauthorization",
      "require explicit scheduled authority reauthorization",
    ],
    [
      normalized.invalidScheduledToolPolicyJobs,
      "cron-scheduled-authority-valid",
      "have invalid scheduled authority provenance",
    ],
  ] as const) {
    if (names.length > 0) {
      findings.push(
        legacyCronStoreFinding({
          message: `${pluralize(names.length, "tool-bearing automation")} ${description}.`,
          path: sqliteStorePath,
          requirement,
          fixHint: `Review with ${formatCliCommand("openclaw automations list")} and reauthorize with ${formatCliCommand("openclaw automations edit <id> --tools <tool,...>")}.`,
        }),
      );
    }
  }

  if (sqliteProjectionBackfillCount > 0) {
    findings.push(
      legacyCronStoreFinding({
        message: `${pluralize(sqliteProjectionBackfillCount, "SQLite cron row")} will be backfilled from stored config JSON into split columns.`,
        path: sqliteStorePath,
        requirement: "sqlite-projection-backfill",
      }),
    );
  }

  const notifyCount = rawJobs.filter((job) => job.notify === true).length;
  if (notifyCount > 0) {
    findings.push(
      legacyCronStoreFinding({
        message: `${pluralize(notifyCount, "job")} still uses legacy notify webhook fallback.`,
        path: sqliteStorePath,
        requirement: "legacy-notify-fallback",
      }),
    );
  }

  const dreamingStaleCount = countStaleDreamingJobs(rawJobs);
  if (dreamingStaleCount > 0) {
    findings.push(
      legacyCronStoreFinding({
        message: `${pluralize(dreamingStaleCount, "managed dreaming job")} still has the legacy heartbeat-coupled shape.`,
        path: sqliteStorePath,
        requirement: "legacy-dreaming-payload",
      }),
    );
  }

  return findings;
}

function noteLegacyCronRepairResult(result: LegacyCronRepairResult): void {
  if (result.changes.length > 0) {
    note(result.changes.join("\n"), "Doctor changes");
  }
  if (result.warnings.length > 0) {
    note(result.warnings.join("\n"), "Doctor warnings");
  }
}

/** Inspect cron storage and optionally repair legacy JSON/SQLite/payload shapes. */
export async function maybeRepairLegacyCronStore(params: {
  cfg: OpenClawConfig;
  options: DoctorOptions;
  prompter: Pick<DoctorPrompter, "confirm">;
}) {
  let state: LegacyCronRepairState | null;
  try {
    state = await loadLegacyCronRepairState({ cfg: params.cfg });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const storePath = resolveCronJobsStorePath(readLegacyCronStorePath(params.cfg));
    note(
      [
        `Unable to read cron job store at ${shortenHomePath(storePath)}.`,
        `- ${reason}`,
        `Fix the file's permissions or contents and re-run ${formatCliCommand("openclaw doctor")}; later health checks will continue.`,
      ].join("\n"),
      "Cron",
    );
    return;
  }
  if (!state) {
    return;
  }
  const {
    storePath,
    legacyStoreDetected,
    legacyRunLogDetected,
    legacyQuarantine,
    legacyImportCount,
    sqliteProjectionBackfillCount,
    invalidConfigRows,
    rawJobs,
  } = state;
  const sqliteStorePath = resolveOpenClawStateSqlitePath();
  try {
    const quarantine = loadCronQuarantinedJobs(storePath);
    if (quarantine.length > 0) {
      note(
        [
          `Quarantined cron job rows found in SQLite at ${shortenHomePath(sqliteStorePath)}.`,
          `- ${pluralize(quarantine.length, "row")} was removed from the active cron store after runtime validation failed.`,
          "- Review or repair quarantined rows before restoring any job to the active cron store.",
        ].join("\n"),
        "Cron",
      );
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    note(
      [
        `Unable to read quarantined cron rows in SQLite at ${shortenHomePath(sqliteStorePath)}.`,
        `- ${reason}`,
      ].join("\n"),
      "Cron",
    );
  }
  if (rawJobs.length === 0) {
    if (
      !legacyStoreDetected &&
      !legacyRunLogDetected &&
      !legacyQuarantine &&
      invalidConfigRows.length === 0
    ) {
      return;
    }
    const previewLines: string[] = [];
    if (legacyStoreDetected) {
      previewLines.push("- legacy JSON cron store will be archived after SQLite migration");
    }
    if (legacyRunLogDetected) {
      previewLines.push("- legacy JSON cron run logs will be imported into SQLite");
    }
    if (legacyQuarantine) {
      previewLines.push("- legacy JSON cron quarantine will be imported into SQLite");
    }
    if (invalidConfigRows.length > 0) {
      previewLines.push(
        `- ${pluralize(invalidConfigRows.length, "malformed cron row")} will be quarantined in SQLite`,
      );
    }
    note(
      [
        `Legacy cron storage detected at ${shortenHomePath(storePath)}.`,
        ...previewLines,
        `Repair with ${formatCliCommand("openclaw doctor --fix")} to finish the migration.`,
      ].join("\n"),
      "Cron",
    );
    const shouldRepair = await params.prompter.confirm({
      message: "Repair legacy cron jobs now?",
      initialValue: true,
    });
    if (!shouldRepair) {
      return;
    }
    noteLegacyCronRepairResult(await applyLegacyCronStoreRepair({ cfg: params.cfg, state }));
    return;
  }
  noteCronModelOverrides({ cfg: params.cfg, jobs: rawJobs });
  noteCronDeliveryTargetAdvisory({ cfg: params.cfg, jobs: rawJobs });

  const inFlightCount = countInFlightCronJobs(rawJobs);
  if (inFlightCount > 0) {
    const subject = inFlightCount === 1 ? "it" : "them";
    note(
      [
        `${pluralize(inFlightCount, "automation")} ${inFlightCount === 1 ? "is" : "are"} still marked in-flight (\`state.runningAtMs\` is set), so ${formatCliCommand("openclaw automations list")} shows ${subject} as \`running\`.`,
        `- If no gateway is currently executing ${subject}, the marker is left over from an interrupted run; the gateway marks such runs interrupted the next time it starts.`,
        `- Review with ${formatCliCommand("openclaw automations list")} or ${formatCliCommand("openclaw automations show <id>")}.`,
      ].join("\n"),
      "Cron",
    );
  }

  const chronicFailureCount = countChronicallyFailingCronJobs(rawJobs);
  if (chronicFailureCount > 0) {
    note(
      [
        `${pluralize(chronicFailureCount, "automation")} ${chronicFailureCount === 1 ? "has" : "have"} failed ${CHRONIC_FAILURE_MIN_CONSECUTIVE_ERRORS}+ runs in a row (\`state.consecutiveErrors\`), so the scheduler only re-fires ${chronicFailureCount === 1 ? "it" : "them"} on error backoff.`,
        `- The count resets on the next successful run and also counts runs interrupted by a gateway restart, so a lasting streak means repeated task failures, repeatedly interrupted runs, or a mix. Failure alerts are opt-in, so this may be the only notice.`,
        `- Review with ${formatCliCommand("openclaw automations list")} or ${formatCliCommand("openclaw automations show <id>")}.`,
      ].join("\n"),
      "Cron",
    );
  }

  const autoDisabledJobs = collectAutoDisabledCronJobs(rawJobs);
  if (autoDisabledJobs.length > 0) {
    note(
      [
        `${pluralize(autoDisabledJobs.length, "automation")} ${autoDisabledJobs.length === 1 ? "is" : "are"} auto-disabled after repeated failures.`,
        ...autoDisabledJobs.map(
          (job) =>
            `- ${job.name} (${job.id}): recorded reason \`${job.reason}\` after ${job.consecutiveErrors} consecutive errors. Fix the cause, then re-enable with ${formatCliCommand(`openclaw automations enable ${job.id}`)}.`,
        ),
      ].join("\n"),
      "Cron",
    );
  }

  const normalized = normalizeStoredCronJobs(rawJobs);
  if (normalized.unsupportedLegacyTriggerScriptJobs.length > 0) {
    note(
      [
        "Legacy cron trigger scripts cannot be safely migrated automatically:",
        ...normalized.unsupportedLegacyTriggerScriptJobs.map((job) => `- ${job}`),
        "Inspect each automation and update its trigger script manually to use direct tool calls.",
      ].join("\n"),
      "Cron",
    );
  }
  const notifyCount = rawJobs.filter((job) => job.notify === true).length;
  const dreamingStaleCount = countStaleDreamingJobs(rawJobs);
  // Unresolved agentTurn command prompts are not auto-fixable; keep them out of the
  // --fix preview so the repair note does not promise a fix that never lands (#94655).
  const commandPromptAdvisory = formatUnresolvedCommandPromptAdvisory(
    normalized.unresolvedAgentTurnCommandPromptJobs,
  );
  if (commandPromptAdvisory) {
    note(commandPromptAdvisory, "Cron");
  }
  const shellPromptAdvisory = formatUnresolvedShellPromptAdvisory(
    normalized.unresolvedAgentTurnShellToolPromptJobs,
  );
  if (shellPromptAdvisory) {
    note(shellPromptAdvisory, "Cron");
  }
  const scheduledToolPolicyAdvisory = formatScheduledToolPolicyAdvisory({
    legacyJobs: normalized.legacyScheduledToolPolicyJobs,
    invalidJobs: normalized.invalidScheduledToolPolicyJobs,
  });
  if (scheduledToolPolicyAdvisory) {
    note(scheduledToolPolicyAdvisory, "Cron");
  }
  const staticMcpByAgentWorkspace = new Map<string, boolean>();
  const incompleteInheritedAuthorityAdvisory = formatIncompleteInheritedAuthorityAdvisory(
    rawJobs
      .filter((job) => {
        const payload = isRecord(job.payload) ? job.payload : undefined;
        const provenance = isRecord(job.toolsAllowProvenance)
          ? job.toolsAllowProvenance
          : undefined;
        if (
          payload?.toolsAllowIsDefault !== true ||
          (provenance?.version === 1 && provenance.source === "final-executable-surface")
        ) {
          return false;
        }
        const agentId =
          typeof job.agentId === "string" && job.agentId.trim()
            ? job.agentId.trim()
            : tryResolveAmbientOwnerAgentId(params.cfg);
        if (!agentId) {
          return false;
        }
        const workspaceDir = resolveAgentWorkspaceDir(params.cfg, agentId);
        const cacheKey = `${agentId}\0${workspaceDir}`;
        let hasStaticMcp = staticMcpByAgentWorkspace.get(cacheKey);
        if (hasStaticMcp === undefined) {
          hasStaticMcp =
            resolveStaticSessionMcpServerNames({
              workspaceDir,
              cfg: params.cfg,
              toolOverrides: resolveCodexMcpToolOverridesForAgent(params.cfg, {
                agentId,
                toolOverrides: undefined,
              }),
            }).length > 0;
          staticMcpByAgentWorkspace.set(cacheKey, hasStaticMcp);
        }
        return hasStaticMcp;
      })
      .map((job) =>
        typeof job.name === "string" && job.name.trim()
          ? job.name.trim()
          : typeof job.id === "string"
            ? job.id
            : "unknown automation",
      ),
  );
  if (incompleteInheritedAuthorityAdvisory) {
    note(incompleteInheritedAuthorityAdvisory, "Cron");
  }
  const previewLines = formatLegacyIssuePreview(normalized.issues);
  if (normalized.legacyTriggerScriptJobs.length > 0) {
    previewLines.push(
      `- ${pluralize(normalized.legacyTriggerScriptJobs.length, "legacy cron trigger script")} will be migrated to direct tool calls: ${normalized.legacyTriggerScriptJobs.join(", ")}`,
    );
  }
  if (legacyStoreDetected) {
    previewLines.unshift(
      legacyImportCount > 0
        ? `- ${pluralize(legacyImportCount, "legacy JSON cron job")} will be imported into SQLite`
        : "- legacy JSON cron store will be archived after SQLite migration",
    );
  }
  if (legacyRunLogDetected) {
    previewLines.push("- legacy JSON cron run logs will be imported into SQLite");
  }
  if (legacyQuarantine) {
    previewLines.push("- legacy JSON cron quarantine will be imported into SQLite");
  }
  if (invalidConfigRows.length > 0) {
    previewLines.push(
      `- ${pluralize(invalidConfigRows.length, "malformed cron row")} will be quarantined in SQLite`,
    );
  }
  if (sqliteProjectionBackfillCount > 0) {
    previewLines.push(
      `- ${pluralize(sqliteProjectionBackfillCount, "SQLite cron row")} will be backfilled from stored config JSON into split columns`,
    );
  }
  if (notifyCount > 0) {
    previewLines.push(
      `- ${pluralize(notifyCount, "job")} still uses legacy \`notify: true\` webhook fallback`,
    );
  }
  if (dreamingStaleCount > 0) {
    previewLines.push(
      `- ${pluralize(dreamingStaleCount, "managed dreaming job")} still has the legacy heartbeat-coupled shape`,
    );
  }
  if (previewLines.length === 0 && !legacyStoreDetected) {
    return;
  }

  const noteHeading = legacyStoreDetected
    ? `Legacy cron job storage detected at ${shortenHomePath(storePath)}.`
    : `Cron store issues detected at ${shortenHomePath(resolveOpenClawStateSqlitePath())}.`;

  note(
    [
      noteHeading,
      ...previewLines,
      `Repair with ${formatCliCommand("openclaw doctor --fix")} to normalize the store before the next scheduler run.`,
    ].join("\n"),
    "Cron",
  );

  const shouldRepair = await params.prompter.confirm({
    message: "Repair legacy cron jobs now?",
    initialValue: true,
  });
  if (!shouldRepair) {
    return;
  }

  noteLegacyCronRepairResult(
    await applyLegacyCronStoreRepair({ cfg: params.cfg, state, normalized }),
  );
}
