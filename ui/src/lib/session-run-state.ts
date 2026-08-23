// Control UI module implements session run state behavior.
import type { SessionRunStatus } from "../api/types.ts";

type SessionRunState = {
  hasActiveRun?: boolean;
  status?: SessionRunStatus;
};

export function isSessionRunActive(state: SessionRunState): boolean {
  if (state.status && state.status !== "running") {
    return false;
  }
  if (typeof state.hasActiveRun === "boolean") {
    return state.hasActiveRun;
  }
  return state.status === "running";
}
