import type { RestartSentinelPayload } from "../infra/restart-sentinel.js";
import { getUpdateRun } from "../infra/update-run-ledger.js";
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

export function formatUpdateRestartActionLines(
  payload: RestartSentinelPayload | null | undefined,
): string[] {
  return payload?.kind === "update" ? readReport(payload).lines : [];
}
