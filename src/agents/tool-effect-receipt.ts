/** Host-owned effect provenance for one completed tool lifecycle. */
export type ToolEffectReceipt = Readonly<{
  state: "not_started" | "read_completed" | "failed_no_effect" | "mutation_committed" | "uncertain";
}>;

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
