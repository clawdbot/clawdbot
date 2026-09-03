/** Crash recovery decisions for durable generation-addressed updates. */
import {
  projectUpdateGenerationTransaction,
  type UpdateGenerationProjection,
  type UpdateGenerationRole,
  type UpdateGenerationSelection,
  type UpdateGenerationTransactionRecord,
} from "./update-generation-contract.js";

export type UpdateGenerationPhysicalState = {
  selector: UpdateGenerationSelection | null;
  selectorDurable: boolean;
  generations: Array<{ generationId: string; manifestSha256: string }>;
  bindingConverged: boolean;
  /** Required to accept a terminal success or rollback receipt. */
  serviceState?: { running: boolean; enabled?: boolean } | null;
};

export type UpdateGenerationRecoveryAction =
  | "resume-materialization"
  | "record-materialized"
  | "persist-baseline-selection-intent"
  | "select-baseline"
  | "stabilize-selector"
  | "record-baseline-selected"
  | "persist-binding-intent"
  | "resume-binding"
  | "record-binding-completed"
  | "persist-candidate-selection-intent"
  | "select-candidate"
  | "record-candidate-selected"
  | "verify-completion"
  | "select-previous"
  | "record-rolled-back"
  | "resume-cleanup"
  | "complete"
  | "adjudicate-failure"
  | "inconsistent";

export type UpdateGenerationRecoveryDecision = {
  action: UpdateGenerationRecoveryAction;
  reason: string;
  role?: UpdateGenerationRole;
  selection?: UpdateGenerationSelection;
};

function selectionsEqual(
  left: UpdateGenerationSelection | null,
  right: UpdateGenerationSelection | null,
): boolean {
  return (
    left?.formatVersion === right?.formatVersion &&
    left?.generationId === right?.generationId &&
    left?.manifestSha256 === right?.manifestSha256 &&
    left?.entrypointRelativePath === right?.entrypointRelativePath
  );
}

function observedGenerationMatches(
  state: UpdateGenerationPhysicalState,
  generationId: string,
  manifestSha256: string,
): boolean {
  return state.generations.some(
    (generation) =>
      generation.generationId === generationId && generation.manifestSha256 === manifestSha256,
  );
}

function durableGenerationPairMatchesPhysical(
  state: UpdateGenerationProjection,
  physical: UpdateGenerationPhysicalState,
): boolean {
  const previous = state.baselineSelection ?? state.intent.previousSelection;
  const candidate = state.candidateSelection ?? state.generations.candidate;
  return Boolean(
    previous &&
    candidate &&
    observedGenerationMatches(physical, previous.generationId, previous.manifestSha256) &&
    observedGenerationMatches(physical, candidate.generationId, candidate.manifestSha256),
  );
}

function selectionIsPhysicallyRunnable(
  physical: UpdateGenerationPhysicalState,
  selection: UpdateGenerationSelection | null,
): boolean {
  return Boolean(
    selection &&
    physical.selectorDurable &&
    selectionsEqual(physical.selector, selection) &&
    observedGenerationMatches(physical, selection.generationId, selection.manifestSha256),
  );
}

function baselineIsPhysicallyRunnable(
  state: UpdateGenerationProjection,
  physical: UpdateGenerationPhysicalState,
): boolean {
  return selectionIsPhysicallyRunnable(
    physical,
    state.baselineSelection ?? state.intent.previousSelection,
  );
}

function terminalGenerationStateMatches(params: {
  state: UpdateGenerationProjection;
  physical: UpdateGenerationPhysicalState;
  selection: UpdateGenerationSelection | null;
}): boolean {
  return (
    params.physical.bindingConverged &&
    params.state.terminalServiceState !== null &&
    params.physical.serviceState != null &&
    params.state.terminalServiceState.running === params.physical.serviceState.running &&
    params.state.terminalServiceState.enabled === params.physical.serviceState.enabled &&
    selectionIsPhysicallyRunnable(params.physical, params.selection) &&
    durableGenerationPairMatchesPhysical(params.state, params.physical)
  );
}

export function adjudicateUpdateGenerationTransaction(
  record: UpdateGenerationTransactionRecord,
  physical: UpdateGenerationPhysicalState,
): UpdateGenerationRecoveryDecision {
  const state = projectUpdateGenerationTransaction(record);
  const latest = state.latest;
  if (latest.kind === "cleanup-completed") {
    const terminalSelection = state.rolledBack
      ? (state.baselineSelection ?? state.intent.previousSelection)
      : state.candidateSelection;
    return terminalGenerationStateMatches({ state, physical, selection: terminalSelection })
      ? { action: "complete", reason: "cleanup receipt and retained generations agree" }
      : {
          action: "inconsistent",
          reason: "cleanup receipt disagrees with selector, bindings, or retained generations",
        };
  }
  if (latest.kind === "cleanup-intent") {
    const terminalSelection = state.rolledBack
      ? (state.baselineSelection ?? state.intent.previousSelection)
      : state.candidateSelection;
    if (!terminalGenerationStateMatches({ state, physical, selection: terminalSelection })) {
      return {
        action: "inconsistent",
        reason: "cleanup intent has no physically converged terminal generation pair",
      };
    }
    const active = physical.selector?.generationId;
    if (active && latest.generationIds.includes(active)) {
      return { action: "inconsistent", reason: "cleanup intent includes the active selector" };
    }
    return { action: "resume-cleanup", reason: "cleanup intent is durable but incomplete" };
  }
  if (latest.kind === "rollback-intent") {
    if (selectionsEqual(physical.selector, latest.to)) {
      if (!physical.selectorDurable) {
        return {
          action: "stabilize-selector",
          selection: latest.to,
          reason: "rollback selector replacement is visible but not proven durable",
        };
      }
      if (!selectionIsPhysicallyRunnable(physical, latest.to)) {
        return {
          action: "inconsistent",
          reason: "rollback selector does not name a runnable prior generation",
        };
      }
      if (!physical.bindingConverged) {
        return {
          action: "inconsistent",
          reason: "rollback selector converged without stable launcher and service bindings",
        };
      }
      return {
        action: "record-rolled-back",
        reason: "selector already names the prior generation",
      };
    }
    if (selectionsEqual(physical.selector, latest.from)) {
      return { action: "select-previous", reason: "rollback intent precedes selector replacement" };
    }
    return { action: "inconsistent", reason: "selector matches neither rollback generation" };
  }
  if (latest.kind === "rolled-back") {
    return terminalGenerationStateMatches({ state, physical, selection: latest.selection })
      ? { action: "complete", reason: "rollback selection and receipt agree" }
      : {
          action: "inconsistent",
          reason: "rolled-back receipt disagrees with selector, bindings, or retained generations",
        };
  }
  if (latest.kind === "failure") {
    return { action: "adjudicate-failure", reason: latest.reason };
  }
  if (latest.kind === "generation-materialization-intent") {
    if (
      latest.role === "candidate" &&
      (!baselineIsPhysicallyRunnable(state, physical) || !physical.bindingConverged)
    ) {
      return {
        action: "inconsistent",
        reason: "candidate materialization has no physically runnable baseline",
      };
    }
    return observedGenerationMatches(physical, latest.generationId, latest.manifest.digest)
      ? {
          action: "record-materialized",
          role: latest.role,
          reason: "generation exists with the durable intended manifest",
        }
      : {
          action: "resume-materialization",
          role: latest.role,
          reason: "generation materialization intent has no matching generation",
        };
  }
  if (latest.kind === "baseline-selection-intent") {
    if (selectionsEqual(physical.selector, latest.selection)) {
      if (!physical.selectorDurable) {
        return {
          action: "stabilize-selector",
          selection: latest.selection,
          reason: "baseline selector replacement is visible but not proven durable",
        };
      }
      return selectionIsPhysicallyRunnable(physical, latest.selection)
        ? { action: "record-baseline-selected", reason: "baseline selector replacement completed" }
        : { action: "inconsistent", reason: "selected baseline generation is unavailable" };
    }
    return selectionsEqual(physical.selector, state.intent.previousSelection)
      ? { action: "select-baseline", reason: "baseline selector replacement is pending" }
      : { action: "inconsistent", reason: "selector matches neither baseline transition state" };
  }
  if (latest.kind === "baseline-selected") {
    if (!selectionIsPhysicallyRunnable(physical, latest.selection)) {
      return {
        action: "inconsistent",
        reason: "durable baseline selection is not physically runnable",
      };
    }
    return {
      action: "persist-binding-intent",
      reason: physical.bindingConverged
        ? "stable bindings converge but their durable intent is not recorded"
        : "baseline is selected before binding migration",
    };
  }
  if (latest.kind === "binding-intent") {
    if (!baselineIsPhysicallyRunnable(state, physical)) {
      return {
        action: "inconsistent",
        reason: "stable binding intent has no physically runnable baseline",
      };
    }
    return physical.bindingConverged
      ? { action: "record-binding-completed", reason: "stable binding migration completed" }
      : { action: "resume-binding", reason: "stable binding intent is durable but incomplete" };
  }
  if (latest.kind === "candidate-selection-intent") {
    if (selectionsEqual(physical.selector, latest.to)) {
      if (!physical.selectorDurable) {
        return {
          action: "stabilize-selector",
          selection: latest.to,
          reason: "candidate selector replacement is visible but not proven durable",
        };
      }
      if (!selectionIsPhysicallyRunnable(physical, latest.to)) {
        return {
          action: "inconsistent",
          reason: "candidate selector does not name a runnable generation",
        };
      }
      if (!physical.bindingConverged) {
        return {
          action: "inconsistent",
          reason: "candidate selector converged without stable launcher and service bindings",
        };
      }
      return {
        action: "record-candidate-selected",
        reason: "candidate selector replacement completed",
      };
    }
    if (selectionsEqual(physical.selector, latest.from)) {
      return baselineIsPhysicallyRunnable(state, physical) &&
        physical.bindingConverged &&
        observedGenerationMatches(physical, latest.to.generationId, latest.to.manifestSha256)
        ? { action: "select-candidate", reason: "candidate selector replacement is pending" }
        : {
            action: "inconsistent",
            reason: "candidate selection lacks a runnable generation pair",
          };
    }
    return { action: "inconsistent", reason: "selector matches neither activation generation" };
  }
  if (latest.kind === "candidate-selected") {
    return selectionIsPhysicallyRunnable(physical, latest.selection) && physical.bindingConverged
      ? {
          action: "verify-completion",
          reason: "candidate is selected but completion is not proven",
        }
      : { action: "inconsistent", reason: "candidate selection receipt disagrees with selector" };
  }
  if (latest.kind === "completion") {
    return terminalGenerationStateMatches({ state, physical, selection: state.candidateSelection })
      ? { action: "complete", reason: "completion receipt and selector agree" }
      : {
          action: "inconsistent",
          reason: "completion receipt disagrees with selector, bindings, or retained generations",
        };
  }
  if (latest.kind === "generation-materialized") {
    if (
      !observedGenerationMatches(
        physical,
        latest.generation.generationId,
        latest.generation.manifestSha256,
      ) ||
      (latest.role === "candidate" &&
        (!baselineIsPhysicallyRunnable(state, physical) || !physical.bindingConverged))
    ) {
      return {
        action: "inconsistent",
        reason: `${latest.role} generation receipt is not physically runnable`,
      };
    }
    return latest.role === "previous"
      ? {
          action: "persist-baseline-selection-intent",
          role: "previous",
          reason: "previous generation is durable and ready for baseline selection",
        }
      : {
          action: "persist-candidate-selection-intent",
          role: "candidate",
          reason: "candidate generation is durable and ready for selection",
        };
  }
  if (latest.kind === "binding-completed") {
    if (!baselineIsPhysicallyRunnable(state, physical) || !physical.bindingConverged) {
      return {
        action: "inconsistent",
        reason: "completed stable binding has no physically runnable baseline",
      };
    }
    return {
      action: "resume-materialization",
      role: "candidate",
      reason: "candidate is not ready",
    };
  }
  if (
    state.intent.stableBindingAlreadyVerified &&
    (!baselineIsPhysicallyRunnable(state, physical) || !physical.bindingConverged)
  ) {
    return {
      action: "inconsistent",
      reason: "verified stable binding has no physically runnable baseline",
    };
  }
  if (!state.intent.stableBindingAlreadyVerified && physical.selector) {
    return {
      action: "inconsistent",
      reason: "bootstrap transaction found an unexpected existing selector",
    };
  }
  return {
    action: "resume-materialization",
    role: state.intent.stableBindingAlreadyVerified ? "candidate" : "previous",
    reason: "transaction intent is durable",
  };
}
