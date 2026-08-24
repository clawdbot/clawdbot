// Shared sequential runner for Claw update mutations with reverse rollback.
import { coerceErrorMessage } from "@openclaw/normalization-core/error-coercion";

export class ClawUpdateMutationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ClawUpdateMutationError";
  }
}

export type OwnedUpdateExecution = {
  appliedIds: string[];
  rollback: () => Promise<void>;
};

type OwnedUpdateStepFailure =
  | { kind: "partial"; message: string; rollbackFirst?: boolean }
  | { kind: "fail"; code: string; message: string }
  | { kind: "rethrow"; error: unknown };

export type OwnedUpdateStep = {
  name: string;
  apply: () => Promise<OwnedUpdateExecution>;
  /** Predecessor step names rolled back in this exact order when apply throws. */
  rollbackAfter?: string[];
  /** Rollback attempted before rollbackAfter; its failure aggregates the same way. */
  ownRollback?: () => Promise<void>;
  /** Mark a non-empty appliedIds on this step as retained shared requirements. */
  retainedOnApply?: boolean;
  onError: (
    error: unknown,
    context: { retainedRequirements: boolean },
  ) => OwnedUpdateStepFailure | Promise<OwnedUpdateStepFailure>;
};

/**
 * Runs update steps in declaration order. When a step throws, its onError
 * classifies the failure, then ownRollback and rollbackAfter run in that
 * exact order; rollback failures flip the outcome to a partial mutation so
 * doctor/resume can reconcile instead of a false clean rollback. Retained
 * requirement steps are never rolled back.
 */
export async function runOwnedUpdateSteps(
  steps: OwnedUpdateStep[],
  options: {
    fail: (code: string, message: string) => Error;
    partial: (message: string) => Error;
  },
): Promise<Map<string, OwnedUpdateExecution>> {
  const executed = new Map<string, OwnedUpdateExecution>();
  let retainedRequirements = false;
  for (const step of steps) {
    try {
      const execution = await step.apply();
      executed.set(step.name, execution);
      if (step.retainedOnApply && execution.appliedIds.length > 0) {
        retainedRequirements = true;
      }
    } catch (error) {
      const failure = await step.onError(error, { retainedRequirements });
      const failureText =
        failure.kind === "rethrow" ? coerceErrorMessage(failure.error) : failure.message;
      const rollbackFailures: string[] = [];
      const attemptRollback = async (
        name: string,
        rollback: () => Promise<void>,
      ): Promise<void> => {
        try {
          await rollback();
        } catch (rollbackError) {
          rollbackFailures.push(`${name} rollback failed: ${coerceErrorMessage(rollbackError)}`);
        }
      };
      // Partial outcomes roll predecessors back only when the step says so:
      // cron partial persists the partial install record instead, and the
      // earlier steps have nothing to undo.
      if (failure.kind !== "partial" || failure.rollbackFirst) {
        if (step.ownRollback) {
          await attemptRollback(step.name, step.ownRollback);
        }
        for (const name of step.rollbackAfter ?? []) {
          const previous = executed.get(name);
          if (previous) {
            await attemptRollback(name, previous.rollback);
          }
        }
      }
      if (rollbackFailures.length > 0) {
        throw options.partial(`${failureText}; ${rollbackFailures.join("; ")}`);
      }
      if (failure.kind === "rethrow") {
        throw failure.error;
      }
      if (failure.kind === "partial") {
        throw options.partial(failure.message);
      }
      throw options.fail(failure.code, failure.message);
    }
  }
  return executed;
}
