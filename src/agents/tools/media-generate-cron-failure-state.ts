import {
  getDetachedMediaCronFailureRecorder,
  type DetachedMediaCronFailureRecorder,
  type DetachedMediaCronFailureRecordRequest,
} from "../../cron/detached-media-failure-recorder.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { MediaGenerationTaskHandle } from "./media-generate-background-shared.js";

const log = createSubsystemLogger("agents/tools/media-generate-cron-failure-state");

export async function markOriginatingCronRunFailedFromMediaGeneration(params: {
  handle: MediaGenerationTaskHandle | null;
  error: unknown;
  toolName: string;
  recorder?: DetachedMediaCronFailureRecorder;
}): Promise<void> {
  const receipt = params.handle?.originatingCronRunReceipt;
  if (!params.handle || !receipt) {
    return;
  }
  const recorder = params.recorder ?? getDetachedMediaCronFailureRecorder(receipt.storeKey);
  if (!recorder) {
    return;
  }
  const request: DetachedMediaCronFailureRecordRequest = {
    cronRunReceipt: receipt,
    ...(params.handle.originatingCronTaskRunId
      ? { cronTaskRunId: params.handle.originatingCronTaskRunId }
      : {}),
    requesterSessionKey: params.handle.requesterSessionKey,
    taskId: params.handle.taskId,
    runId: params.handle.runId,
    toolName: params.toolName,
    error: `Detached ${params.toolName} failed: ${formatErrorMessage(params.error)}`,
  };
  try {
    await recorder(request);
  } catch (error) {
    log.warn("Failed to record detached media failure on its originating cron run", {
      jobId: receipt.jobId,
      taskId: params.handle.taskId,
      runId: params.handle.runId,
      error,
    });
  }
}
