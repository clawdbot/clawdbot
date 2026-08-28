// Heartbeat wake reasons are displayed/logged, so normalize blanks to a stable
// default before they reach scheduling or diagnostics.
/** Normalize a heartbeat wake reason for logs and UI. */
type HeartbeatReasonKind =
  | "retry"
  | "interval"
  | "manual"
  | "exec-event"
  | "wake"
  | "cron"
  | "hook"
  | "other";

function trimReason(reason?: string): string {
  return reason?.trim() ?? "";
}

export function normalizeHeartbeatWakeReason(reason?: string): string {
  const trimmed = trimReason(reason);
  return trimmed.length > 0 ? trimmed : "requested";
}

export function resolveHeartbeatReasonKind(reason?: string): HeartbeatReasonKind {
  const trimmed = trimReason(reason);
  if (trimmed === "retry") {
    return "retry";
  }
  if (trimmed === "interval") {
    return "interval";
  }
  if (trimmed === "manual") {
    return "manual";
  }
  if (trimmed === "exec-event") {
    return "exec-event";
  }
  if (trimmed === "wake") {
    return "wake";
  }
  if (trimmed === "continuation") {
    return "wake";
  }
  if (trimmed === "silent-wake-enrichment") {
    return "wake";
  }
  if (trimmed === "delegate-return") {
    return "wake";
  }
  if (trimmed.startsWith("acp:spawn:")) {
    return "wake";
  }
  if (trimmed.startsWith("cron:")) {
    return "cron";
  }
  if (trimmed.startsWith("hook:")) {
    return "hook";
  }
  return "other";
}

export function isHeartbeatEventDrivenReason(reason?: string): boolean {
  const kind = resolveHeartbeatReasonKind(reason);
  return kind === "exec-event" || kind === "cron" || kind === "wake" || kind === "hook";
}

export function isHeartbeatActionWakeReason(reason?: string): boolean {
  const kind = resolveHeartbeatReasonKind(reason);
  return kind === "manual" || kind === "exec-event" || kind === "hook";
}
