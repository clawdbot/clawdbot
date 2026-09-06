import type { RestartSentinelPayload } from "../infra/restart-sentinel.js";
import { findActiveUpdateRun, getUpdateRun, listUpdateRuns } from "../infra/update-run-ledger.js";
import {
  renderUpdateRunReport,
  updateRunReportInputFromSentinel,
} from "../infra/update-run-report.js";

type Formatter = (value: string) => string;

function readReport(payload: RestartSentinelPayload) {
  const run = payload.stats?.runId ? getUpdateRun(payload.stats.runId) : undefined;
  return renderUpdateRunReport(run ?? updateRunReportInputFromSentinel(payload));
}

export function formatUpdateRestartStatusValue(
  payload: RestartSentinelPayload | null | undefined,
  opts: { ok?: Formatter; warn?: Formatter; muted?: Formatter } = {},
): string | null {
  if (!payload || payload.kind !== "update") {
    return null;
  }
  const headline = readReport(payload).headline;
  const format =
    payload.status === "error" ? opts.warn : payload.status === "ok" ? opts.ok : opts.muted;
  return format ? format(headline) : headline;
}

/** Keep recorded progress and history separate from the current installation's update check. */
export function buildStatusUpdateRows(
  payload: RestartSentinelPayload | null | undefined,
  opts: Parameters<typeof formatUpdateRestartStatusValue>[1] = {},
) {
  const run = findActiveUpdateRun() ?? listUpdateRuns({ limit: 1 })[0];
  const rows = run ? [{ Item: "Update run", Value: renderUpdateRunReport(run).headline }] : [];
  // Legacy sentinels lack run IDs; matching prose cannot establish the same occurrence.
  const restart =
    !run || payload?.stats?.runId !== run.runId
      ? formatUpdateRestartStatusValue(payload, opts)
      : null;
  return restart ? [...rows, { Item: "Update restart", Value: restart }] : rows;
}

export function formatUpdateRestartActionLines(
  payload: RestartSentinelPayload | null | undefined,
): string[] {
  return payload?.kind === "update" ? readReport(payload).lines : [];
}
