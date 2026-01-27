export type HeartbeatRunResult =
  | { status: "ran"; durationMs: number }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

export type HeartbeatWakeHandler = (opts: { reason?: string }) => Promise<HeartbeatRunResult>;

let handler: HeartbeatWakeHandler | null = null;
let pendingReason: string | null = null;
let scheduled = false;
let running = false;
let timer: NodeJS.Timeout | null = null;

const DEFAULT_COALESCE_MS = 250;
const DEFAULT_RETRY_MS = 1_000;

function schedule(coalesceMs: number) {
  if (timer) return;
  timer = setTimeout(async () => {
    timer = null;
    scheduled = false;
    const active = handler;
    if (!active) return;
    if (running) {
      scheduled = true;
      schedule(coalesceMs);
      return;
    }

    const reason = pendingReason;
    pendingReason = null;
    running = true;
    try {
      const res = await active({ reason: reason ?? undefined });
      if (res.status === "skipped" && res.reason === "requests-in-flight") {
        // The main lane is busy; retry soon.
        pendingReason = reason ?? "retry";
        schedule(DEFAULT_RETRY_MS);
      }
    } catch {
      // Error is already logged by the heartbeat runner; schedule a retry.
      pendingReason = reason ?? "retry";
      schedule(DEFAULT_RETRY_MS);
    } finally {
      running = false;
      if (pendingReason || scheduled) schedule(coalesceMs);
    }
  }, coalesceMs);
  timer.unref?.();
}

export function setHeartbeatWakeHandler(next: HeartbeatWakeHandler | null) {
  handler = next;
  if (handler && pendingReason) {
    schedule(DEFAULT_COALESCE_MS);
  }
}

export function requestHeartbeatNow(opts?: { reason?: string; coalesceMs?: number }) {
  pendingReason = opts?.reason ?? pendingReason ?? "requested";
  schedule(opts?.coalesceMs ?? DEFAULT_COALESCE_MS);
}

export function hasHeartbeatWakeHandler() {
  return handler !== null;
}

export function hasPendingHeartbeatWake() {
  return pendingReason !== null || Boolean(timer) || scheduled;
}
