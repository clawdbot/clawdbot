/** Host-owned effect provenance for one completed tool lifecycle. */
export type ToolEffectReceipt = Readonly<{
  state: "not_started" | "read_completed" | "failed_no_effect" | "mutation_committed" | "uncertain";
}>;

const toolEffectReceipts = new WeakMap<object, ToolEffectReceipt>();

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

/** Bind provenance to the exact host-owned value crossing the next boundary. */
export function registerToolEffectReceipt<T>(target: T, receipt: ToolEffectReceipt): T {
  if ((typeof target === "object" && target !== null) || typeof target === "function") {
    toolEffectReceipts.set(target, receipt);
  }
  return target;
}

/** Move one receipt across a host-owned projection without making it model-visible. */
export function transferToolEffectReceipt(source: unknown, target: unknown): void {
  const receipt = consumeToolEffectReceipt(source);
  if (receipt) {
    registerToolEffectReceipt(target, receipt);
  }
}

/** Consume provenance once so copied or replayed values cannot inherit authority. */
export function consumeToolEffectReceipt(target: unknown): ToolEffectReceipt | undefined {
  if ((typeof target !== "object" || target === null) && typeof target !== "function") {
    return undefined;
  }
  const receipt = toolEffectReceipts.get(target);
  toolEffectReceipts.delete(target);
  return receipt;
}

/** Return whether one recorded operation state proves that no mutation could have occurred. */
export function toolEffectStateProvesNoEffect(state: ToolEffectReceipt["state"]): boolean {
  return state === "not_started" || state === "read_completed" || state === "failed_no_effect";
}
