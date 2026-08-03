/** Composes queued admission, canonical execution, accounting, and delivery. */
import { hasCompletedSourceReplyDeliveryEvidence } from "../../agents/embedded-agent-runner/delivery-evidence.js";
import { clearAgentRunContext } from "../../infra/agent-run-registry.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { defaultRuntime } from "../../runtime.js";
import { accountFollowupTurn } from "./agent-runner-result-accounting.js";
import { deliverFollowupDecision, resolveFollowupDeliveryDecision } from "./followup-delivery.js";
import {
  admitFollowupTurn,
  settleQueuedFollowupPresentation,
  type AdmittedFollowupTurn,
  type FollowupRunnerParams,
} from "./followup-turn-admission.js";
import { executeFollowupTurn } from "./followup-turn-execution.js";
import {
  completeFollowupRunLifecycle,
  FollowupRunDeferredError,
  type FollowupRun,
} from "./queue.js";
import type { ReplyOperation } from "./reply-run-registry.js";

type FollowupDrainDisposition =
  | { kind: "consumed" }
  | { kind: "deferred"; reason: string }
  | { kind: "retry"; error: unknown };

/** Creates the function that drains one queued follow-up run. */
export function createFollowupRunner(
  defaults: FollowupRunnerParams,
): (queued: FollowupRun) => Promise<void> {
  const runFollowup = async (queued: FollowupRun): Promise<void> => {
    let disposition: FollowupDrainDisposition = { kind: "retry", error: undefined };
    let operation: ReplyOperation | undefined;
    let admittedRunId: string | undefined;
    let executionStarted = false;
    let queuedFollowupAdmitted = false;
    const initiallyAborted =
      queued.abortSignal?.aborted === true || queued.queueAbortSignal?.aborted === true;
    const endDeliveryCorrelations = initiallyAborted
      ? []
      : (queued.deliveryCorrelations ?? [])
          .map((correlation) => correlation.begin())
          .filter((end): end is () => void => typeof end === "function");
    try {
      if (initiallyAborted) {
        disposition = { kind: "consumed" };
        return;
      }
      const admission = await admitFollowupTurn({
        queued,
        defaults,
        onCompactionNoticePayload: async (payload, turn) => {
          await deliverFollowupDecision({
            decision: { kind: "deliver", payloads: [payload] },
            turn,
            defaults,
            runId: turn.runId,
            runFollowup,
            kind: "block",
          });
        },
      });
      switch (admission.kind) {
        case "deferred":
          throw new FollowupRunDeferredError(
            `Follow-up reply lane is still active (${admission.reason})`,
          );
        case "skipped":
          operation = admission.operation;
          disposition = { kind: "consumed" };
          return;
        case "admitted":
          break;
      }
      const turn: AdmittedFollowupTurn = admission.turn;
      admittedRunId = turn.runId;
      operation = turn.operation;
      queuedFollowupAdmitted = true;
      const execution = await executeFollowupTurn({
        turn,
        defaults,
        onExecutionStarted: () => {
          executionStarted = true;
        },
        onToolResult: async (payload, identity) => {
          await deliverFollowupDecision({
            decision: { kind: "deliver", payloads: [payload] },
            turn,
            defaults,
            runId: identity.runId,
            runFollowup,
            kind: "tool",
          });
        },
        onCompactionNoticePayload: async (payload, identity) => {
          await deliverFollowupDecision({
            decision: { kind: "deliver", payloads: [payload] },
            turn,
            defaults,
            runId: identity.runId,
            runFollowup,
            kind: "block",
          });
        },
      });
      try {
        await execution.progress.drain();
      } catch (error) {
        // Execution already settled; replaying the queued prompt could duplicate side effects.
        defaultRuntime.error?.(
          `followup queue: progress presentation failed after execution: ${formatErrorMessage(error)}`,
        );
        operation.fail("run_failed", error);
      }
      if (
        execution.execution.outcome.kind === "settled" &&
        hasCompletedSourceReplyDeliveryEvidence(execution.execution.outcome.result)
      ) {
        await defaults.opts?.onObservedReplyDelivery?.();
      }
      const accounting = await accountFollowupTurn({ turn, defaults, execution });
      const decision = resolveFollowupDeliveryDecision({
        turn,
        execution: execution.execution,
        accounting,
        opts: defaults.opts,
      });
      await deliverFollowupDecision({
        decision,
        turn,
        defaults,
        runId: execution.execution.runId,
        runFollowup,
      });
      disposition = { kind: "consumed" };
    } catch (error) {
      if (error instanceof FollowupRunDeferredError) {
        disposition = { kind: "deferred", reason: error.message };
      } else if (
        operation?.result?.kind === "aborted" &&
        operation.result.code === "aborted_by_user"
      ) {
        disposition = { kind: "consumed" };
      } else if (executionStarted) {
        // There is no durable post-execution resume record yet. Requeueing the prompt
        // here can duplicate persisted turns and external tool side effects. Preserve
        // the terminal failure through complete() rather than reporting success.
        defaultRuntime.error?.(
          `followup queue: execution failed after start; refusing replay: ${formatErrorMessage(error)}`,
        );
        operation?.fail("run_failed", error);
        disposition = { kind: "consumed" };
      } else {
        disposition = { kind: "retry", error };
      }
    } finally {
      if (queuedFollowupAdmitted) {
        await settleQueuedFollowupPresentation(defaults);
      }
      for (const end of endDeliveryCorrelations.toReversed()) {
        try {
          end();
        } catch (error) {
          defaultRuntime.error?.(
            `followup queue: delivery correlation cleanup failed: ${formatErrorMessage(error)}`,
          );
        }
      }
      if (disposition.kind === "consumed") {
        completeFollowupRunLifecycle(queued);
        if (admittedRunId) {
          clearAgentRunContext(admittedRunId);
        }
      } else if (disposition.kind === "retry" && admittedRunId) {
        clearAgentRunContext(admittedRunId);
      }
      operation?.complete();
      defaults.typing.markRunComplete();
      defaults.typing.markDispatchIdle();
    }
    if (disposition.kind === "deferred") {
      throw new FollowupRunDeferredError(
        `Follow-up reply lane is still active (${disposition.reason})`,
      );
    }
    if (disposition.kind === "retry") {
      throw disposition.error;
    }
  };
  return runFollowup;
}
