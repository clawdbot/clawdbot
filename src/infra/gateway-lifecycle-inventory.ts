// Reviewed source inventory for the Arxi host-lifecycle contract.
export const ARXI_LIFECYCLE_REVIEWED_UPSTREAM_COMMIT = "cd299e6726b1140d5182f4d3bd1cc4f80c896d16";

export const GATEWAY_LIFECYCLE_ACTIVE_PRODUCERS = [
  { id: "command-queue", countKey: "queueSize" },
  { id: "reply-dispatch", countKey: "pendingReplies" },
  { id: "embedded-agent-run", countKey: "embeddedRuns" },
  { id: "background-exec", countKey: "backgroundExecSessions" },
  { id: "cron-run-and-watchers", countKey: "cronRuns" },
  { id: "task-registry", countKey: "activeTasks" },
  { id: "gateway-root-request", countKey: "rootRequests" },
  { id: "session-work-admission", countKey: "sessionAdmissions" },
  { id: "session-lifecycle-mutation", countKey: "sessionMutations" },
  { id: "chat-run", countKey: "chatRuns" },
  { id: "queued-chat-turn", countKey: "queuedTurns" },
  { id: "terminal-persistence", countKey: "terminalPersistence" },
  { id: "terminal-session", countKey: "terminalSessions" },
] as const;

export const GATEWAY_LIFECYCLE_TIME_BASED_PRODUCERS = [
  { id: "cron", wakeSource: "CronService.getSuspendWakeSnapshot" },
] as const;
