import {
  getAgentEventLifecycleGeneration,
  isAgentEventLifecycleGenerationCurrent,
} from "../infra/agent-events.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

// Display-only pending facts span persistence and runtime acknowledgement, including
// the gap between interrupted and replacement attempts. They never grant authority.
const pendingChanges = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionPermissionChanges"),
  () => new Map<string, { generation: string }>(),
);

export function beginSessionPermissionChange(sessionId: string): () => void {
  const owner = { generation: getAgentEventLifecycleGeneration() };
  pendingChanges.set(sessionId, owner);
  return () => {
    if (pendingChanges.get(sessionId) === owner) {
      pendingChanges.delete(sessionId);
    }
  };
}

export function isSessionPermissionChangePending(sessionId: string | undefined): boolean {
  const pending = sessionId === undefined ? undefined : pendingChanges.get(sessionId);
  return pending !== undefined && isAgentEventLifecycleGenerationCurrent(pending.generation);
}
