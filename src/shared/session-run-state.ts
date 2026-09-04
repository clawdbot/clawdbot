import type { SessionRunStatus } from "../../packages/gateway-protocol/src/schema/sessions-row.js";

type SessionRunState = {
  hasActiveRun?: boolean;
  status?: SessionRunStatus;
};

export function isSessionRunActive(state: SessionRunState): boolean {
  if (state.status && state.status !== "queued" && state.status !== "running") {
    return false;
  }
  if (typeof state.hasActiveRun === "boolean") {
    return state.hasActiveRun;
  }
  return state.status === "queued" || state.status === "running";
}
