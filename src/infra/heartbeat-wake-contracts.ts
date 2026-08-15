export type HeartbeatRunResult =
  | { status: "ran"; durationMs: number }
  | { status: "skipped"; reason: string; retryAtMs?: number }
  | { status: "failed"; reason: string };

export type HeartbeatWakeIntent = "scheduled" | "task" | "event" | "immediate" | "manual";

export type HeartbeatWakeSource =
  | "interval"
  | "manual"
  | "exec-event"
  | "notifications-event"
  | "cron"
  | "hook"
  | "background-task"
  | "background-task-blocked"
  | "acp-spawn"
  | "session-state"
  | "cli-watchdog"
  | "restart-sentinel"
  | "retry"
  | "other";

export type HeartbeatWakeOverride = {
  target?: string;
  to?: string | undefined;
  accountId?: string | undefined;
};

/** Cron-owned periodic work carried directly into a guarded heartbeat turn. */
export type HeartbeatScheduledTask = {
  jobId: string;
  name: string;
  prompt: string;
};

export type HeartbeatWakeRequest = {
  source: HeartbeatWakeSource;
  intent: HeartbeatWakeIntent;
  reason?: string;
  agentId?: string;
  sessionKey?: string;
  heartbeat?: HeartbeatWakeOverride;
  /** Persisted cron monitor cadence carried with a scheduled heartbeat tick. */
  scheduledEveryMs?: number;
  /** Persisted cron monitor phase anchor carried with a scheduled heartbeat tick. */
  scheduledAnchorMs?: number;
  tasks?: readonly HeartbeatScheduledTask[];
  /** Internal marker for work retained after a spacing/cooldown deferral. */
  retainedWork?: boolean;
};

export type HeartbeatWakeHandler = (opts: HeartbeatWakeRequest) => Promise<HeartbeatRunResult>;
