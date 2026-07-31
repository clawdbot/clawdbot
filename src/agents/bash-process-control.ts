// Shared control seam for task-ledger and process-tool cancellation.
import { getProcessSupervisor } from "../process/supervisor/index.js";
import { getSession } from "./bash-process-registry.js";

export function isBackgroundExecSessionActive(sessionId: string): boolean {
  const session = getSession(sessionId);
  return Boolean(session?.backgrounded && !session.exited);
}

export function cancelBackgroundExecSession(sessionId: string): boolean {
  const session = getSession(sessionId);
  if (!session?.backgrounded || session.exited || session.finalizing) {
    return false;
  }
  const supervisor = getProcessSupervisor();
  const record = supervisor.getRecord(sessionId);
  if (!record || record.state === "exited") {
    return false;
  }
  supervisor.cancel(sessionId, "manual-cancel");
  return true;
}
