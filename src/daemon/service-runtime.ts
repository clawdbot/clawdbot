/** Shared daemon runtime status types and systemd cgroup hygiene helpers. */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

/** systemd cgroup fields used to spot unhealthy gateway service supervision. */
export type GatewayServiceSystemdRuntime = {
  unit?: string;
  killMode?: string;
  tasksCurrent?: number;
  memoryCurrent?: number;
};

export type GatewayServiceRuntime = {
  status?: string;
  state?: string;
  subState?: string;
  pid?: number;
  lastExitStatus?: number;
  lastExitReason?: string;
  lastRunResult?: string;
  lastRunTime?: string;
  detail?: string;
  cachedLabel?: boolean;
  missingUnit?: boolean;
  missingSupervision?: boolean;
  systemd?: GatewayServiceSystemdRuntime;
};

export const SYSTEMD_TASKS_CURRENT_WARNING_THRESHOLD = 200;
export const SYSTEMD_MEMORY_CURRENT_WARNING_BYTES = 2 * 1024 * 1024 * 1024;

export function isRiskySystemdKillMode(value: string | undefined): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(value);
  return normalized === "process" || normalized === "none";
}

function formatBytesAsGiB(value: number): string {
  const gib = value / 1024 / 1024 / 1024;
  const formatted = gib >= 1 ? gib.toFixed(1).replace(/\.0$/, "") : `${value}B`;
  return gib >= 1 ? `${formatted}GiB` : formatted;
}

function describeSystemdCgroupLoadWarnings(runtime?: GatewayServiceSystemdRuntime): string[] {
  if (!runtime) {
    return [];
  }
  const killMode = runtime?.killMode;
  if (!isRiskySystemdKillMode(killMode)) {
    return [];
  }
  // KillMode=process/none only becomes noisy when the cgroup is visibly large.
  const details: string[] = [];
  if (
    runtime.tasksCurrent !== undefined &&
    Number.isSafeInteger(runtime.tasksCurrent) &&
    runtime.tasksCurrent >= SYSTEMD_TASKS_CURRENT_WARNING_THRESHOLD
  ) {
    details.push(`tasks=${runtime.tasksCurrent}`);
  }
  if (
    runtime.memoryCurrent !== undefined &&
    Number.isSafeInteger(runtime.memoryCurrent) &&
    runtime.memoryCurrent >= SYSTEMD_MEMORY_CURRENT_WARNING_BYTES
  ) {
    details.push(`memory=${formatBytesAsGiB(runtime.memoryCurrent)}`);
  }
  return details;
}

export function getSystemdCgroupHygieneSummary(
  runtime?: GatewayServiceSystemdRuntime,
): string | null {
  if (!runtime || !runtime.killMode) {
    return null;
  }
  const details = describeSystemdCgroupLoadWarnings(runtime);
  if (details.length === 0) {
    return null;
  }
  return `cgroup hygiene: KillMode=${runtime.killMode}, ${details.join(", ")}`;
}

export function isSystemdCgroupHygieneRisk(runtime?: GatewayServiceSystemdRuntime): boolean {
  return getSystemdCgroupHygieneSummary(runtime) !== null;
}
