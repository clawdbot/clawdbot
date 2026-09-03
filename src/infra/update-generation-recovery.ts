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
  generations: Array<{ generationId: string; manifestSha256: string }>;
  bindingConverged: boolean;
};

export type UpdateGenerationRecoveryAction =
  | "resume-materialization"
  | "record-materialized"
  | "persist-baseline-selection-intent"
  | "select-baseline"
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

function terminalGenerationStateMatches(params: {
  state: UpdateGenerationProjection;
  physical: UpdateGenerationPhysicalState;
  selection: UpdateGenerationSelection | null;
}): boolean {
  return (
    params.physical.bindingConverged &&
    selectionsEqual(params.physical.selector, params.selection) &&
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
    const active = physical.selector?.generationId;
    if (active && latest.generationIds.includes(active)) {
      return { action: "inconsistent", reason: "cleanup intent includes the active selector" };
    }
    return { action: "resume-cleanup", reason: "cleanup intent is durable but incomplete" };
  }
  if (latest.kind === "rollback-intent") {
    if (selectionsEqual(physical.selector, latest.to)) {
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
    return selectionsEqual(physical.selector, latest.selection)
      ? { action: "record-baseline-selected", reason: "baseline selector replacement completed" }
      : { action: "select-baseline", reason: "baseline selector replacement is pending" };
  }
  if (latest.kind === "baseline-selected") {
    return {
      action: "persist-binding-intent",
      reason: physical.bindingConverged
        ? "stable bindings converge but their durable intent is not recorded"
        : "baseline is selected before binding migration",
    };
  }
  if (latest.kind === "binding-intent") {
    return physical.bindingConverged
      ? { action: "record-binding-completed", reason: "stable binding migration completed" }
      : { action: "resume-binding", reason: "stable binding intent is durable but incomplete" };
  }
  if (latest.kind === "candidate-selection-intent") {
    if (selectionsEqual(physical.selector, latest.to)) {
      return {
        action: "record-candidate-selected",
        reason: "candidate selector replacement completed",
      };
    }
    if (selectionsEqual(physical.selector, latest.from)) {
      return { action: "select-candidate", reason: "candidate selector replacement is pending" };
    }
    return { action: "inconsistent", reason: "selector matches neither activation generation" };
  }
  if (latest.kind === "candidate-selected") {
    return selectionsEqual(physical.selector, latest.selection)
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
    return {
      action: "resume-materialization",
      role: "candidate",
      reason: "candidate is not ready",
    };
  }
  return {
    action: "resume-materialization",
    role: state.intent.stableBindingAlreadyVerified ? "candidate" : "previous",
    reason: "transaction intent is durable",
  };
}
