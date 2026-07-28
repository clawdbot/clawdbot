/** Shared daemon runtime status types and systemd cgroup hygiene helpers. */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

/** systemd supervision fields used to spot unhealthy or given-up gateway service state. */
type GatewayServiceSystemdRuntime = {
  unit?: string;
  killMode?: string;
  tasksCurrent?: number;
  memoryCurrent?: number;
  // systemd `Result` (e.g. success, exit-code, start-limit-hit) plus the restart
  // counter and configured StartLimitBurst. Together they detect a crash-loop
  // give-up that the collapsed `status` string and `Result` alone cannot.
  result?: string;
  nRestarts?: number;
  startLimitBurst?: number;
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
  missingGuiSession?: boolean;
  systemd?: GatewayServiceSystemdRuntime;
};

const SYSTEMD_TASKS_CURRENT_WARNING_THRESHOLD = 200;
const SYSTEMD_MEMORY_CURRENT_WARNING_BYTES = 2 * 1024 * 1024 * 1024;

// EX_CONFIG (78) from sysexits.h. The generated systemd unit pins
// RestartPreventExitStatus=78 (see systemd-unit.ts) so the gateway's
// config-error / duplicate-lock exit (gateway-cli run) deliberately stops
// without a restart. A last exit of 78 therefore means systemd gave up on
// purpose, not that it exhausted StartLimitBurst, so any accumulated NRestarts
// is stale from earlier crashes and must not drive start-limit detection.
const SYSTEMD_NO_RESTART_EXIT_STATUS = 78;

function isRiskySystemdKillMode(value: string | undefined): boolean {
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

/**
 * True when systemd has stopped auto-restarting the gateway because it crashed
 * faster than StartLimitBurst/StartLimitIntervalSec allows. Unlike an ordinary
 * stopped/exited unit, this terminal latch needs an explicit `reset-failed` +
 * restart to recover, so status/doctor must surface it instead of the generic
 * "exited immediately" message.
 *
 * Detection: the unit is `failed` and either systemd reported the give-up
 * directly (Result=start-limit-hit, the start-was-refused-before-exec case) or
 * the restart counter reached the configured burst. The counter path is the
 * common one: once the gateway process has actually run and exited non-zero,
 * systemd keeps Result=exit-code and never overwrites it with start-limit-hit
 * (verified against systemd 249), so Result alone misses real crash loops.
 *
 * The counter path is guarded against the deliberate no-restart exit: a last
 * exit of 78 (EX_CONFIG, held back by RestartPreventExitStatus=78) means
 * systemd stopped on purpose, so a stale NRestarts left over from earlier
 * crashes must not be mistaken for start-limit exhaustion. The explicit
 * Result=start-limit-hit signal stays authoritative regardless of exit status.
 */
export function isSystemdStartLimitHit(runtime?: GatewayServiceRuntime): boolean {
  if (!runtime || normalizeLowercaseStringOrEmpty(runtime.state) !== "failed") {
    return false;
  }
  const systemd = runtime.systemd;
  if (!systemd) {
    return false;
  }
  if (normalizeLowercaseStringOrEmpty(systemd.result) === "start-limit-hit") {
    return true;
  }
  if (runtime.lastExitStatus === SYSTEMD_NO_RESTART_EXIT_STATUS) {
    return false;
  }
  return (
    typeof systemd.startLimitBurst === "number" &&
    systemd.startLimitBurst > 0 &&
    typeof systemd.nRestarts === "number" &&
    systemd.nRestarts >= systemd.startLimitBurst
  );
}
