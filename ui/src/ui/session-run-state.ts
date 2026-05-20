import type { SessionRunStatus } from "./types.ts";

type SessionRunState = {
  hasActiveRun?: boolean;
  status?: SessionRunStatus;
};

export function isSessionRunActive(state: SessionRunState): boolean {
  if (state.status) {
    return state.status === "running";
  }
  return state.hasActiveRun === true;
}
