import type {
  ClawLifecyclePlanResult,
  ClawStatusEntry,
} from "../../../../packages/gateway-protocol/src/index.js";

type ClawCatalogCoordinate = { packageName: string; version: string };
export type ClawSetupAnswers = Record<string, string | number | boolean | string[]>;

export type PendingClawOperation =
  | {
      operation: "add";
      source: ClawCatalogCoordinate;
      agentId?: string;
      answers?: ClawSetupAnswers;
    }
  | {
      operation: "update";
      target: string;
      source?: ClawCatalogCoordinate;
      answers?: ClawSetupAnswers;
    }
  | {
      operation: "configure";
      target: string;
      answers?: ClawSetupAnswers;
      clearAnswers?: string[];
      regenerateSeeds?: string[];
    }
  | { operation: "remove"; target: string };

export function catalogUpdateTargets(
  records: readonly ClawStatusEntry[],
  packageName: string,
  selectedAgentId: string | null,
  selectedAgentExplicit: boolean,
): ClawStatusEntry[] {
  const matches = records.filter((record) => record.name === packageName);
  const selected = selectedAgentExplicit
    ? matches.find((record) => record.agentId === selectedAgentId)
    : undefined;
  return selected ? [selected] : matches;
}

export function seedDestinationsForAnswer(
  setup: ClawLifecyclePlanResult["setup"],
  inputId: string,
): string[] {
  return (
    setup?.seeds
      .filter((seed) => seed.inputIds.includes(inputId))
      .map((seed) => seed.destination) ?? []
  );
}

export function setupAnswerEditable(plan: ClawLifecyclePlanResult, inputId: string): boolean {
  if (plan.operation !== "update") {
    return true;
  }
  const activeSeeds = new Set(
    plan.actions
      .filter(
        (action) =>
          action.kind === "personalizationSeed" &&
          action.action !== "unchanged" &&
          action.action !== "release",
      )
      .map((action) => action.id),
  );
  return seedDestinationsForAnswer(plan.setup, inputId).some((destination) =>
    activeSeeds.has(destination),
  );
}

export function buildClawApplyRequest(params: {
  pending: PendingClawOperation;
  plan: ClawLifecyclePlanResult;
  removeUnused: boolean;
  riskAcknowledged: boolean;
}): { method: string; request: Record<string, unknown> } | null {
  const { pending, plan } = params;
  if (pending.operation !== plan.operation || plan.blockers.length > 0) {
    return null;
  }
  if (plan.riskAcknowledgementRequired && !params.riskAcknowledged) {
    return null;
  }
  const consent = params.riskAcknowledged ? { acknowledgeClawHubRisk: true } : {};
  if (pending.operation === "add") {
    return {
      method: "claws.add.apply",
      request: {
        source: pending.source,
        ...(pending.agentId ? { agentId: pending.agentId } : {}),
        ...(pending.answers ? { answers: pending.answers } : {}),
        planIntegrity: plan.planIntegrity,
        ...consent,
      },
    };
  }
  if (pending.operation === "update") {
    return {
      method: "claws.update.apply",
      request: {
        target: pending.target,
        ...(pending.source ? { source: pending.source } : {}),
        ...(pending.answers ? { answers: pending.answers } : {}),
        planIntegrity: plan.planIntegrity,
        ...consent,
      },
    };
  }
  if (pending.operation === "configure") {
    return {
      method: "claws.configure.apply",
      request: {
        target: pending.target,
        ...(pending.answers ? { answers: pending.answers } : {}),
        ...(pending.clearAnswers ? { clearAnswers: pending.clearAnswers } : {}),
        ...(pending.regenerateSeeds ? { regenerateSeeds: pending.regenerateSeeds } : {}),
        planIntegrity: plan.planIntegrity,
      },
    };
  }
  return {
    method: "claws.remove.apply",
    request: {
      target: pending.target,
      removeUnused: params.removeUnused,
      planIntegrity: plan.planIntegrity,
    },
  };
}
