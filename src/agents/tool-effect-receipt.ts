import {
  attachInternalToolResultProvenance,
  getInternalToolResultProvenance,
} from "./runtime/internal-hooks.js";

/** Host-owned effect provenance for one completed tool lifecycle. */
export type ToolEffectReceipt = Readonly<{
  state: "not_started" | "read_completed" | "failed_no_effect" | "mutation_committed" | "uncertain";
}>;

const NO_START_RECEIPT: ToolEffectReceipt = Object.freeze({ state: "not_started" });

/** Keep effect proof private while the lifecycle copies or projects the result. */
export function markToolExecutionNotStarted<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    attachInternalToolResultProvenance(value, NO_START_RECEIPT);
  }
  return value;
}

export function readToolEffectReceipt(value: unknown): ToolEffectReceipt | undefined {
  return typeof value === "object" &&
    value !== null &&
    getInternalToolResultProvenance(value) === NO_START_RECEIPT
    ? NO_START_RECEIPT
    : undefined;
}

export function consumeToolExecutionNotStarted(value: unknown): boolean {
  if (
    typeof value !== "object" ||
    value === null ||
    getInternalToolResultProvenance(value) !== NO_START_RECEIPT
  ) {
    return false;
  }
  attachInternalToolResultProvenance(value, undefined);
  return true;
}

/** The protected operation owns its first possible effect, including reservations. */
export async function withToolEffectBoundary<T>(
  execute: (onEffectsStart: () => void) => Promise<T>,
): Promise<T> {
  let effectsStarted = false;
  const settle = <TValue>(value: TValue): TValue => {
    if (!effectsStarted) {
      return markToolExecutionNotStarted(value);
    }
    // A nested no-start failure cannot erase effects already attempted by this owner.
    consumeToolExecutionNotStarted(value);
    return value;
  };
  try {
    return settle(
      await execute(() => {
        effectsStarted = true;
      }),
    );
  } catch (error) {
    throw settle(error);
  }
}

/** Resolve the strongest effect fact available at the terminal lifecycle owner. */
export function buildToolEffectReceipt(params: {
  executionStarted: boolean;
  mutatingAction: boolean;
  replaySafe: boolean;
  outcome: "success" | "failure";
}): ToolEffectReceipt {
  if (!params.executionStarted) {
    // Hooks and approvals may have run before implementation entry. Only their
    // explicit no-start proof can upgrade this otherwise-uncertain boundary.
    return { state: "uncertain" };
  }
  if (params.replaySafe) {
    return {
      state: params.outcome === "success" ? "read_completed" : "failed_no_effect",
    };
  }
  return {
    state:
      params.mutatingAction && params.outcome === "success" ? "mutation_committed" : "uncertain",
  };
}
