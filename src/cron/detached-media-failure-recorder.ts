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

type DetachedMediaCronFailureRecorder = (
  request: DetachedMediaCronFailureRecordRequest,
) => Promise<void> | void;

let recorder: DetachedMediaCronFailureRecorder | undefined;

export function registerDetachedMediaCronFailureRecorder(
  next: DetachedMediaCronFailureRecorder,
): () => void {
  recorder = next;
  return () => {
    if (recorder === next) {
      recorder = undefined;
    }
  };
}

export function getDetachedMediaCronFailureRecorder():
  | DetachedMediaCronFailureRecorder
  | undefined {
  return recorder;
}
