import { listChannelPlugins } from "../../channels/plugins/index.js";
import { parseAbsoluteTimeMs } from "../../cron/parse.js";
import { resolveCronStaggerMs } from "../../cron/stagger.js";
import type { CronDeliveryPreview, CronJob, CronSchedule } from "../../cron/types.js";
import { danger } from "../../globals.js";
import { formatDurationHuman } from "../../infra/format-time/format-duration.ts";
import {
  isOffsetlessIsoDateTime,
  parseOffsetlessIsoDateTimeInTimeZone,
} from "../../infra/format-time/parse-offsetless-zoned-datetime.js";
import { defaultRuntime, type RuntimeEnv } from "../../runtime.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import { colorize, isRich, theme } from "../../terminal/theme.js";
import type { GatewayRpcOpts } from "../gateway-rpc.js";
import { callGatewayFromCli } from "../gateway-rpc.js";

export const getCronChannelOptions = () => {
  // Keep help truthful even before the plugin registry is bootstrapped.
  const pluginIds = listChannelPlugins()
    .map((plugin) => plugin.id)
    .filter(Boolean);
  return pluginIds.length > 0 ? ["last", ...pluginIds].join("|") : "last|<channel-id>";
};

export function printCronJson(value: unknown) {
  defaultRuntime.writeJson(value);
}

export function handleCronCliError(err: unknown) {
  defaultRuntime.error(danger(String(err)));
  defaultRuntime.exit(1);
}

export async function warnIfCronSchedulerDisabled(opts: GatewayRpcOpts) {
  try {
    const res = (await callGatewayFromCli("cron.status", opts, {})) as {
      enabled?: boolean;
      storePath?: string;
    };
    if (res?.enabled === true) {
      return;
    }
    const store = typeof res?.storePath === "string" ? res.storePath : "";
    defaultRuntime.error(
      [
        "warning: cron scheduler is disabled in the Gateway; jobs are saved but will not run automatically.",
        "Re-enable with `cron.enabled: true` (or remove `cron.enabled: false`) and restart the Gateway.",
        store ? `store: ${store}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  } catch {
    // Ignore status failures (older gateway, offline, etc.)
  }
}

export function parseDurationMs(input: string): number | null {
  const raw = input.trim();
  if (!raw) {
    return null;
  }
  const match = raw.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/i);
  if (!match) {
    return null;
  }
  const n = Number.parseFloat(match[1] ?? "");
  if (!Number.isFinite(n) || n <= 0) {
    return null;
  }
  const unit = normalizeLowercaseStringOrEmpty(match[2] ?? "");
  const factor =
    unit === "ms"
      ? 1
      : unit === "s"
        ? 1000
        : unit === "m"
          ? 60_000
          : unit === "h"
            ? 3_600_000
            : 86_400_000;
  return Math.floor(n * factor);
}

export function parseCronStaggerMs(params: {
  staggerRaw: string;
  useExact: boolean;
}): number | undefined {
  if (params.useExact) {
    return 0;
  }
  if (!params.staggerRaw) {
    return undefined;
  }
  const parsed = parseDurationMs(params.staggerRaw);
  if (!parsed) {
    throw new Error("Invalid --stagger; use e.g. 30s, 1m, 5m");
  }
  return parsed;
}

export function parseCronToolsAllow(input: unknown): string[] | undefined {
  const raw = Array.isArray(input)
    ? input.map((value) => String(value)).join(" ")
    : typeof input === "string"
      ? input
      : "";
  const tools = raw
    .split(/[,\s]+/u)
    .map((tool) => normalizeOptionalString(tool))
    .filter((tool): tool is string => Boolean(tool));
  return tools.length > 0 ? tools : undefined;
}

/**
 * Parse a one-shot `--at` value into an ISO string (UTC).
 *
 * When `tz` is provided and the input is an offset-less datetime
 * (e.g. `2026-03-23T23:00:00`), the datetime is interpreted in
 * that IANA timezone instead of UTC.
 */
export function parseAt(input: string, tz?: string): string | null {
  const raw = input.trim();
  if (!raw) {
    return null;
  }

  // If a timezone is provided and the input looks like an offset-less ISO datetime,
  // resolve it in the given IANA timezone so users get the time they expect.
  if (tz && isOffsetlessIsoDateTime(raw)) {
    return parseOffsetlessIsoDateTimeInTimeZone(raw, tz);
  }

  const absolute = parseAbsoluteTimeMs(raw);
  if (absolute !== null) {
    return new Date(absolute).toISOString();
  }
  const dur = parseDurationMs(raw);
  if (dur !== null) {
    return new Date(Date.now() + dur).toISOString();
  }
  return null;
}

const CRON_ID_PAD = 36;
const CRON_NAME_PAD = 24;
const CRON_SCHEDULE_PAD = 32;
const CRON_NEXT_PAD = 10;
const CRON_LAST_PAD = 10;
const CRON_STATUS_PAD = 9;
const CRON_TARGET_PAD = 9;
const CRON_DELIVERY_PAD = 64;
const CRON_AGENT_PAD = 10;
const CRON_MODEL_PAD = 20;

const stringifyCell = (value: unknown, fallback = "-") => {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
};

const pad = (value: unknown, width: number) => stringifyCell(value).padEnd(width);

const truncate = (value: string, width: number) => {
  if (value.length <= width) {
    return value;
  }
  if (width <= 3) {
    return value.slice(0, width);
  }
  return `${value.slice(0, width - 3)}...`;
};

const formatIsoMinute = (iso: string) => {
  const parsed = parseAbsoluteTimeMs(iso);
  const d = new Date(parsed ?? Number.NaN);
  if (Number.isNaN(d.getTime())) {
    return "-";
  }
  const isoStr = d.toISOString();
  return `${isoStr.slice(0, 10)} ${isoStr.slice(11, 16)}Z`;
};

const formatSpan = (ms: number) => {
  if (ms < 60_000) {
    return "<1m";
  }
  if (ms < 3_600_000) {
    return `${Math.round(ms / 60_000)}m`;
  }
  if (ms < 86_400_000) {
    return `${Math.round(ms / 3_600_000)}h`;
  }
  return `${Math.round(ms / 86_400_000)}d`;
};

const formatRelative = (ms: number | null | undefined, nowMs: number) => {
  if (!ms) {
    return "-";
  }
  const delta = ms - nowMs;
  const label = formatSpan(Math.abs(delta));
  return delta >= 0 ? `in ${label}` : `${label} ago`;
};

const formatSchedule = (schedule: CronSchedule | undefined) => {
  if (schedule?.kind === "at") {
    return `at ${formatIsoMinute(schedule.at)}`;
  }
  if (schedule?.kind === "every") {
    return `every ${formatDurationHuman(schedule.everyMs)}`;
  }
  if (schedule?.kind !== "cron") {
    return "-";
  }
  const base = schedule.tz ? `cron ${schedule.expr} @ ${schedule.tz}` : `cron ${schedule.expr}`;
  const staggerMs = resolveCronStaggerMs(schedule);
  if (staggerMs <= 0) {
    return `${base} (exact)`;
  }
  return `${base} (stagger ${formatDurationHuman(staggerMs)})`;
};

const formatStatus = (job: CronJob) => {
  if (!job.enabled) {
    return "disabled";
  }
  const state = job.state ?? {};
  if (state.runningAtMs) {
    return "running";
  }
  return state.lastStatus ?? "idle";
};

export function coerceCronDeliveryPreviews(value: unknown): Map<string, CronDeliveryPreview> {
  const previews =
    value && typeof value === "object"
      ? (value as { deliveryPreviews?: unknown }).deliveryPreviews
      : undefined;
  if (!previews || typeof previews !== "object") {
    return new Map();
  }
  return new Map(
    Object.entries(previews as Record<string, unknown>).flatMap(([jobId, preview]) => {
      if (!preview || typeof preview !== "object") {
        return [];
      }
      const record = preview as { label?: unknown; detail?: unknown };
      if (typeof record.label !== "string" || typeof record.detail !== "string") {
        return [];
      }
      return [[jobId, { label: record.label, detail: record.detail }]];
    }),
  );
}

export function printCronList(
  jobs: CronJob[],
  runtime: RuntimeEnv = defaultRuntime,
  opts?: { deliveryPreviews?: Map<string, CronDeliveryPreview> },
) {
  if (jobs.length === 0) {
    runtime.log("No cron jobs.");
    return;
  }

  const rich = isRich();
  const header = [
    pad("ID", CRON_ID_PAD),
    pad("Name", CRON_NAME_PAD),
    pad("Schedule", CRON_SCHEDULE_PAD),
    pad("Next", CRON_NEXT_PAD),
    pad("Last", CRON_LAST_PAD),
    pad("Status", CRON_STATUS_PAD),
    pad("Target", CRON_TARGET_PAD),
    pad("Delivery", CRON_DELIVERY_PAD),
    pad("Agent ID", CRON_AGENT_PAD),
    pad("Model", CRON_MODEL_PAD),
  ].join(" ");

  runtime.log(rich ? theme.heading(header) : header);
  const now = Date.now();

  for (const job of jobs) {
    const state = job.state ?? {};
    const idLabel = pad(job.id, CRON_ID_PAD);
    const nameLabel = pad(truncate(stringifyCell(job.name), CRON_NAME_PAD), CRON_NAME_PAD);
    const scheduleLabel = pad(
      truncate(formatSchedule(job.schedule), CRON_SCHEDULE_PAD),
      CRON_SCHEDULE_PAD,
    );
    const nextLabel = pad(
      job.enabled ? formatRelative(state.nextRunAtMs, now) : "-",
      CRON_NEXT_PAD,
    );
    const lastLabel = pad(formatRelative(state.lastRunAtMs, now), CRON_LAST_PAD);
    const statusRaw = formatStatus(job);
    const statusLabel = pad(statusRaw, CRON_STATUS_PAD);
    const targetLabel = pad(job.sessionTarget ?? "-", CRON_TARGET_PAD);
    const deliveryPreview = opts?.deliveryPreviews?.get(job.id);
    const deliveryText = deliveryPreview
      ? `${deliveryPreview.label} (${deliveryPreview.detail})`
      : "-";
    const deliveryLabel = pad(truncate(deliveryText, CRON_DELIVERY_PAD), CRON_DELIVERY_PAD);
    const agentLabel = pad(truncate(job.agentId ?? "-", CRON_AGENT_PAD), CRON_AGENT_PAD);
    const modelLabel = pad(
      truncate(
        (job.payload?.kind === "agentTurn" ? job.payload.model : undefined) ?? "-",
        CRON_MODEL_PAD,
      ),
      CRON_MODEL_PAD,
    );

    const coloredStatus = (() => {
      if (statusRaw === "ok") {
        return colorize(rich, theme.success, statusLabel);
      }
      if (statusRaw === "error") {
        return colorize(rich, theme.error, statusLabel);
      }
      if (statusRaw === "running") {
        return colorize(rich, theme.warn, statusLabel);
      }
      if (statusRaw === "skipped") {
        return colorize(rich, theme.muted, statusLabel);
      }
      return colorize(rich, theme.muted, statusLabel);
    })();

    const coloredTarget =
      job.sessionTarget === "main"
        ? colorize(rich, theme.accent, targetLabel)
        : colorize(rich, theme.accentBright, targetLabel);
    const coloredAgent = job.agentId
      ? colorize(rich, theme.info, agentLabel)
      : colorize(rich, theme.muted, agentLabel);

    const line = [
      colorize(rich, theme.accent, idLabel),
      colorize(rich, theme.info, nameLabel),
      colorize(rich, theme.info, scheduleLabel),
      colorize(rich, theme.muted, nextLabel),
      colorize(rich, theme.muted, lastLabel),
      coloredStatus,
      coloredTarget,
      deliveryPreview
        ? colorize(rich, theme.info, deliveryLabel)
        : colorize(rich, theme.muted, deliveryLabel),
      coloredAgent,
      job.payload?.kind === "agentTurn" && job.payload.model
        ? colorize(rich, theme.info, modelLabel)
        : colorize(rich, theme.muted, modelLabel),
    ].join(" ");

    runtime.log(line.trimEnd());
  }
}

export function printCronShow(
  job: CronJob,
  runtime: RuntimeEnv = defaultRuntime,
  opts?: { deliveryPreview?: CronDeliveryPreview },
) {
  const preview = opts?.deliveryPreview ?? { label: "-", detail: "unavailable" };
  runtime.log(`id: ${job.id}`);
  runtime.log(`name: ${job.name}`);
  runtime.log(`enabled: ${job.enabled ? "yes" : "no"}`);
  runtime.log(`schedule: ${formatSchedule(job.schedule)}`);
  runtime.log(`session: ${job.sessionTarget ?? "-"}`);
  runtime.log(`agent: ${job.agentId ?? "-"}`);
  runtime.log(`model: ${job.payload.kind === "agentTurn" ? (job.payload.model ?? "-") : "-"}`);
  runtime.log(`delivery: ${preview.label} (${preview.detail})`);
  runtime.log(`next: ${formatRelative(job.state.nextRunAtMs, Date.now())}`);
  runtime.log(`last: ${formatRelative(job.state.lastRunAtMs, Date.now())}`);
  runtime.log(`status: ${formatStatus(job)}`);
  runtime.log(`diagnostic: ${job.state.lastDiagnosticSummary ?? "-"}`);
}
