export type SessionStateActorType = "human" | "agent" | "system";

export type SessionStateEventKind =
  | "human_direct_message"
  | "adopted"
  | "run_completed"
  | "run_failed"
  | "child_spawned"
  | "goal_changed"
  | "upstream_missing"
  | "compacted";

// Future utility-model materiality belongs at this deterministic seam; no config until then.
export const NOTIFY_BY_SESSION_STATE_EVENT_KIND: Record<SessionStateEventKind, boolean> = {
  human_direct_message: true,
  upstream_missing: true,
  adopted: false,
  goal_changed: true,
  run_completed: false,
  run_failed: false,
  child_spawned: false,
  compacted: false,
};
