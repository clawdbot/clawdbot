import type { CronJob, GatewaySessionRow } from "../api/types.ts";
// Control UI module implements presenter behavior.
import { t } from "../i18n/index.ts";
import { resolveCronJobLastRunStatus } from "../lib/cron-status.ts";
import {
  formatDateMs,
  formatRelativeTimestamp,
  formatDurationHuman,
  formatMs,
  formatUnknownText,
} from "../lib/format.ts";

export function formatNextRun(ms?: number | null) {
  if (!ms) {
    return t("common.na");
  }
  const weekday = formatDateMs(ms, { weekday: "short" });
  if (weekday === t("common.na")) {
    return weekday;
  }
  return `${weekday}, ${formatMs(ms)} (${formatRelativeTimestamp(ms)})`;
}

export function formatSessionTokens(row: GatewaySessionRow) {
  if (row.totalTokens == null) {
    return t("common.na");
  }
  const total = row.totalTokens ?? 0;
  const ctx = row.contextTokens ?? 0;
  return ctx ? `${total} / ${ctx}` : String(total);
}

export function formatEventPayload(payload: unknown): string {
  if (payload == null) {
    return "";
  }
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return formatUnknownText(payload);
  }
}

export function formatCronState(job: CronJob) {
  const state = job.state ?? {};
  const next = state.nextRunAtMs ? formatMs(state.nextRunAtMs) : t("common.na");
  const last = state.lastRunAtMs ? formatMs(state.lastRunAtMs) : t("common.na");
  const status = resolveCronJobLastRunStatus(job);
  return `${status} · next ${next} · last ${last}`;
}

export function formatCronSchedule(job: CronJob) {
  const s = job.schedule;
  if (s.kind === "at") {
    const atMs = Date.parse(s.at);
    return Number.isFinite(atMs) ? `At ${formatMs(atMs)}` : `At ${s.at}`;
  }
  if (s.kind === "every") {
    return `Every ${formatDurationHuman(s.everyMs)}`;
  }
  if (s.kind === "on-exit") {
    // on-exit jobs carry a watched command (+ optional cwd), not a cron expr;
    // without this branch they fall through and render "Cron undefined".
    return `On exit: ${s.command}${s.cwd ? ` (cwd: ${s.cwd})` : ""}`;
  }
  return `Cron ${s.expr}${s.tz ? ` (${s.tz})` : ""}`;
}

export function formatCronPayload(job: CronJob) {
  const p = job.payload;
  if (p.kind === "systemEvent") {
    return `System: ${p.text}`;
  }
  if (p.kind === "command") {
    return `Command: ${p.argv.join(" ")}`;
  }
  const base = `Agent: ${p.message}`;
  const delivery = job.delivery;
  if (delivery && delivery.mode !== "none") {
    const target =
      delivery.mode === "webhook"
        ? delivery.to
          ? ` (${delivery.to})`
          : ""
        : delivery.channel || delivery.to
          ? ` (${delivery.channel ?? "last"}${delivery.to ? ` -> ${delivery.to}` : ""})`
          : "";
    return `${base} · ${delivery.mode}${target}`;
  }
  return base;
}
