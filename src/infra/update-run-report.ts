import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { UPDATE_RUN_PHASES } from "../../packages/gateway-protocol/src/update-run-vocabulary.js";
import { formatDurationPrecise } from "./format-time/format-duration.ts";
import type { RestartSentinelPayload } from "./restart-sentinel-store.js";
import { summarizeUpdateStepFailure, type UpdateRunRecord } from "./update-run-record.js";
import type { UpdateRunResult } from "./update-runner-types.js";

export type UpdateRunReport = { headline: string; lines: string[]; markdown: string };
type ReportInput = Pick<
  UpdateRunRecord,
  | "status"
  | "phase"
  | "reason"
  | "origin"
  | "before"
  | "after"
  | "steps"
  | "verification"
  | "repair"
  | "downtimeMs"
>;
const PHASES = new Set<string>(UPDATE_RUN_PHASES);

function bounded(text: string, limit: number): string {
  return text.length <= limit ? text : `${sliceUtf16Safe(text, 0, limit - 1)}…`;
}

function recoveryHints(run: ReportInput, nextAction?: string): string[] {
  if (run.status === "running") {
    return ["Check progress with openclaw update status."];
  }
  if (run.status !== "failed") {
    return [];
  }
  const hints: string[] = [];
  if (run.reason === "preflight-insufficient-space") {
    hints.push(
      "Free space on the preflight staging and package-manager store filesystems, then rerun the update.",
    );
  } else if (run.reason === "pnpm-corepack-missing") {
    hints.push(
      "This pnpm checkout could not auto-enable pnpm because corepack is missing. Install pnpm manually or install Node with corepack available, then rerun the update command.",
    );
  } else if (run.reason === "pnpm-corepack-enable-failed") {
    hints.push(
      "Run corepack enable manually or install pnpm manually, then rerun the update command.",
    );
  } else if (run.reason === "pnpm-npm-bootstrap-failed") {
    hints.push(
      "This pnpm checkout could not bootstrap pnpm from npm automatically. Install pnpm manually, then rerun the update command.",
    );
  } else if (run.reason === "preferred-manager-unavailable") {
    hints.push(
      "Install the checkout's declared package manager manually, then rerun the update command.",
    );
  }
  if (!nextAction) {
    hints.push("Run openclaw triage to diagnose and repair the failed update.");
  }
  return hints;
}

/** One report for persisted update outcomes; markdown reserves room for the next action. */
export function renderUpdateRunReport(
  run: ReportInput,
  opts: { doctorHint?: string | null; nextAction?: string } = {},
): UpdateRunReport {
  const before = run.before.version ?? run.before.sha?.slice(0, 8);
  const after = run.after.version ?? run.after.sha?.slice(0, 8);
  const reason = bounded(run.reason?.trim() || "unknown reason", 240);
  const running =
    run.verification.serviceRunning === false ? undefined : run.verification.runningVersion;
  let headline: string;
  switch (run.status) {
    case "succeeded":
      headline = after
        ? `✅ OpenClaw updated to ${after}${before ? ` (from ${before})` : ""}.`
        : "✅ OpenClaw updated.";
      break;
    case "failed":
      headline = `⚠️ OpenClaw update failed: ${reason}.${running ? ` The gateway is running ${running}.` : ""}`;
      break;
    case "skipped":
      headline = `ℹ️ OpenClaw update skipped: ${reason}.`;
      break;
    case "rolled-back":
      headline = `↩️ OpenClaw update rolled back to ${after ?? running ?? before ?? "the previous version"}: ${reason}.`;
      break;
    case "running":
      headline = `⬆️ OpenClaw update in progress: ${run.phase}.`;
      break;
  }
  headline = bounded(headline, 500);
  const lines: string[] = [];
  const phases = run.steps
    .filter((step) => PHASES.has(step.step))
    .map((step) => {
      const duration =
        step.startedAtMs != null && step.endedAtMs != null
          ? ` (${formatDurationPrecise(Math.max(0, step.endedAtMs - step.startedAtMs))})`
          : "";
      return `${step.step}${duration}`;
    });
  if (phases.length) {
    lines.push(`Phases: ${phases.join(" → ")}`);
  }
  for (const step of run.steps.filter((item) => item.status === "failed").slice(-3)) {
    lines.push(bounded(`Failed: ${step.step}${step.detail ? ` — ${step.detail}` : ""}`, 300));
  }
  const verification: string[] = [];
  const facts = run.verification;
  if (facts.booted) {
    verification.push("gateway booted");
  }
  if (facts.serviceRunning !== undefined) {
    verification.push(facts.serviceRunning ? "service running" : "service stopped");
  }
  if (facts.versionMatch !== undefined) {
    verification.push(facts.versionMatch ? "version verified" : "version mismatch");
  }
  if (facts.channelsReady !== undefined) {
    verification.push(facts.channelsReady ? "channels ready" : "channels not ready");
  }
  if (facts.inferenceProbe) {
    verification.push(`inference ${facts.inferenceProbe}`);
  }
  if (facts.pluginErrors?.length) {
    verification.push(`${facts.pluginErrors.length} plugin activation error(s)`);
  }
  if (verification.length) {
    lines.push(`Verification: ${verification.join("; ")}.`);
  }
  for (const attempt of run.repair.slice(-3)) {
    lines.push(
      bounded(
        `Repair ${attempt.attempt}: ${attempt.status}${attempt.summary || attempt.reason ? ` — ${attempt.summary ?? attempt.reason}` : ""}`,
        300,
      ),
    );
  }
  if (run.downtimeMs != null) {
    lines.push(`Gateway downtime: ${formatDurationPrecise(run.downtimeMs)}.`);
  }
  const nextAction = opts.nextAction ?? run.origin.nextAction;
  const hints =
    run.status === "running"
      ? recoveryHints(run)
      : [
          ...new Set(
            [
              opts.doctorHint ?? facts.doctorHint ?? run.origin.doctorHint,
              ...recoveryHints(run, nextAction),
              nextAction,
            ].filter((line): line is string => Boolean(line)),
          ),
        ];
  lines.push(...hints);
  const next = hints.at(-1);
  const body = [headline, ...lines.filter((line) => line !== next)].join("\n");
  const suffix = next ? `\n${bounded(next, 1100)}` : "";
  return { headline, lines, markdown: `${bounded(body, 1500 - suffix.length)}${suffix}` };
}

/** Old CLI finalization paths still return runner results; all wording stays in the report. */
export function updateRunReportInputFromResult(result: UpdateRunResult): ReportInput {
  return {
    status: result.status === "ok" ? "succeeded" : result.status === "error" ? "failed" : "skipped",
    phase: "finished",
    reason: result.reason ?? null,
    origin: {},
    before: result.before ?? {},
    after: result.after ?? {},
    verification: {},
    repair: [],
    downtimeMs: null,
    steps: result.steps.map((step) => ({
      step: step.name,
      status: step.exitCode === 0 || step.advisory ? "completed" : "failed",
      ...(step.exitCode !== 0
        ? { detail: step.advisory?.message ?? summarizeUpdateStepFailure(step) }
        : {}),
    })),
  };
}

/** Stable releases can leave a pre-ledger sentinel across an upgrade. */
export function updateRunReportInputFromSentinel(payload: RestartSentinelPayload): ReportInput {
  const stats = payload.stats;
  const version = (value: Record<string, unknown> | null | undefined) => ({
    ...(typeof value?.version === "string" ? { version: value.version } : {}),
    ...(typeof value?.sha === "string" ? { sha: value.sha } : {}),
  });
  const pending =
    payload.status === "skipped" &&
    (stats?.reason === "managed-service-handoff-started" ||
      stats?.reason === "restart-health-pending");
  return {
    status: pending
      ? "running"
      : payload.status === "ok"
        ? "succeeded"
        : payload.status === "error"
          ? "failed"
          : "skipped",
    phase: pending ? "restarting" : "finished",
    reason: stats?.reason ?? null,
    origin: payload.doctorHint ? { doctorHint: payload.doctorHint } : {},
    before: version(stats?.before),
    after: version(stats?.after),
    verification: {},
    repair: [],
    downtimeMs: null,
    steps: (stats?.steps ?? []).map((step) => ({
      step: step.name,
      status: step.log?.exitCode === 0 ? "completed" : "failed",
    })),
  };
}
