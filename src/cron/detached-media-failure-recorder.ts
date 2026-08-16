import type { AgentRunCronReceipt } from "../infra/agent-run-registry-claim-values.js";

/** Exact detached-media failure fact accepted only by the live Gateway cron owner. */
export type DetachedMediaCronFailureRecordRequest = {
  cronRunReceipt: AgentRunCronReceipt;
  cronTaskRunId?: string;
  requesterSessionKey: string;
  taskId: string;
  runId: string;
  toolName: string;
  error: string;
};

export type DetachedMediaCronFailureRecorder = (
  request: DetachedMediaCronFailureRecordRequest,
) => Promise<void> | void;

const recordersByStoreKey = new Map<string, DetachedMediaCronFailureRecorder>();

export function registerDetachedMediaCronFailureRecorder(
  storeKey: string,
  next: DetachedMediaCronFailureRecorder,
): () => void {
  // Same-store successors replace the writer; different stores remain
  // independently addressable by each receipt's durable key.
  recordersByStoreKey.set(storeKey, next);
  return () => {
    if (recordersByStoreKey.get(storeKey) === next) {
      recordersByStoreKey.delete(storeKey);
    }
  };
}

export function getDetachedMediaCronFailureRecorder(
  storeKey: string,
): DetachedMediaCronFailureRecorder | undefined {
  return recordersByStoreKey.get(storeKey);
}
