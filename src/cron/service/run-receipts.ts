import { resolveCronJobEffectiveAgentId } from "../agent-id.js";
import {
  assertCronRunReceiptCurrent,
  assertCronRunReceiptCurrentInDatabase,
  claimCronRunReceipt,
  CronRunReceiptRevisionError,
  finishCronRunReceipt,
  finishCronRunReceiptInDatabase,
  type CronRunReceiptHandle,
  type CronRunReceiptStatus,
} from "../store/run-receipt-store.js";
import type { CronStoreTransactionHooks } from "../store/transaction-hooks.js";
import type { CronJob, CronRunStatus } from "../types.js";
import type { CronServiceState } from "./state.js";

function currentDefaultAgentId(state: CronServiceState): string | undefined {
  return state.deps.resolveDefaultAgentId?.() ?? state.deps.defaultAgentId;
}

function resolveCronRunReceiptAgentId(state: CronServiceState, job: CronJob): string {
  return resolveCronJobEffectiveAgentId(job, currentDefaultAgentId(state));
}

function resolveAgentId(state: CronServiceState) {
  return (job: CronJob) => resolveCronRunReceiptAgentId(state, job);
}

export function claimServiceCronRunReceipt(params: {
  state: CronServiceState;
  job: CronJob;
  startedAtMs: number;
  requestRunId?: string;
}): CronRunReceiptHandle {
  return claimCronRunReceipt({
    storePath: params.state.deps.storePath,
    job: params.job,
    agentId: resolveCronRunReceiptAgentId(params.state, params.job),
    startedAtMs: params.startedAtMs,
    requestRunId: params.requestRunId,
    resolveAgentId: resolveAgentId(params.state),
  });
}

export function assertServiceCronRunReceiptCurrent(
  state: CronServiceState,
  handle: CronRunReceiptHandle,
): void {
  assertCronRunReceiptCurrent({
    handle,
    resolveAgentId: resolveAgentId(state),
    isAgentAvailable: state.deps.isAgentAvailable,
  });
}

function terminalReceiptStatus(status: CronRunStatus): Exclude<CronRunReceiptStatus, "running"> {
  if (status === "ok") {
    return "ok";
  }
  if (status === "skipped") {
    return "skipped";
  }
  return "error";
}

export function cronRunReceiptPersistHooks(params: {
  state: CronServiceState;
  handle: CronRunReceiptHandle;
  terminal?: { status: CronRunStatus; finishedAtMs: number; error?: string };
}): CronStoreTransactionHooks {
  return {
    beforeWrite: (database) => {
      if (params.state.deps.isAgentAvailable?.(params.handle.agentId) === false) {
        throw new CronRunReceiptRevisionError(
          params.handle.receiptId,
          `cron run owner ${params.handle.agentId} is no longer configured`,
        );
      }
      assertCronRunReceiptCurrentInDatabase({
        database,
        handle: params.handle,
        resolveAgentId: resolveAgentId(params.state),
      });
    },
    ...(params.terminal
      ? {
          afterWrite: (
            database: Parameters<NonNullable<CronStoreTransactionHooks["afterWrite"]>>[0],
          ) => {
            finishCronRunReceiptInDatabase({
              database,
              handle: params.handle,
              status: terminalReceiptStatus(params.terminal!.status),
              finishedAtMs: params.terminal!.finishedAtMs,
              error: params.terminal!.error,
            });
          },
        }
      : {}),
  };
}

export function supersedeServiceCronRunReceipt(
  handle: CronRunReceiptHandle,
  finishedAtMs: number,
  error: string,
): void {
  finishCronRunReceipt({
    handle,
    status: "superseded",
    finishedAtMs,
    error,
  });
}
