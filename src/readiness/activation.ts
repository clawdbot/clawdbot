import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { findModelInCatalog } from "../agents/model-catalog-lookup.js";
import { getCurrentProviderAuthStates } from "../agents/model-provider-auth-state.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection-config.js";
import {
  getPreparedModelRuntimeSnapshot,
  type PreparedModelRuntimeSnapshot,
} from "../agents/prepared-model-runtime.js";
import {
  listConfiguredOwnerInputs,
  type PreparedModelRuntimeInput,
} from "../agents/prepared-model-runtime.owner.js";
import {
  getRuntimeConfigAppliedHash,
  getRuntimeConfigSnapshotMetadata,
  hashRuntimeConfigValue,
  type RuntimeConfigSnapshotMetadata,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  listActiveDegradedSecretOwners,
  type DegradedSecretOwner,
} from "../secrets/runtime-degraded-state.js";
import type { ReadinessCondition } from "./conditions.js";

export const CONFIG_CURRENT_CRITERION_ID = "openclaw.config-current";
export const MODEL_ROUTE_READY_CRITERION_ID = "openclaw.model-route-ready";
export const SECRETS_READY_CRITERION_ID = "openclaw.secrets-ready";

export type ActivationReadinessCriterionId =
  | typeof CONFIG_CURRENT_CRITERION_ID
  | typeof MODEL_ROUTE_READY_CRITERION_ID
  | typeof SECRETS_READY_CRITERION_ID;

export function isReadinessCriterionSelected(config: OpenClawConfig, id: string): boolean {
  return [
    ...(config.gateway?.readiness?.requiredCriteria ?? []),
    ...(config.gateway?.readiness?.advisoryCriteria ?? []),
  ].includes(id);
}

type ActivationReadinessDeps = {
  configCurrent(): ReadinessCondition;
  modelRouteReady(config: OpenClawConfig, env?: NodeJS.ProcessEnv): ReadinessCondition;
  secretsReady(): ReadinessCondition;
};

type ModelRouteReadinessSources = {
  listOwners(config: OpenClawConfig): PreparedModelRuntimeInput[];
  getSnapshot(input: PreparedModelRuntimeInput): PreparedModelRuntimeSnapshot | undefined;
  getProviderAuthStates: typeof getCurrentProviderAuthStates;
};

function unknownCondition(type: string, reason: string, message: string): ReadinessCondition {
  return { type, status: "Unknown", requirement: "advisory", reason, message };
}

export function buildConfigCurrentCondition(
  metadata: RuntimeConfigSnapshotMetadata | null = getRuntimeConfigSnapshotMetadata(),
  appliedHash: string | null = getRuntimeConfigAppliedHash(),
): ReadinessCondition {
  if (!metadata?.sourceFingerprint || !appliedHash) {
    return unknownCondition(
      "ConfigCurrent",
      "ConfigGenerationUnavailable",
      "The active and source configuration generations are not both available.",
    );
  }
  const current = metadata.sourceFingerprint === appliedHash;
  return {
    type: "ConfigCurrent",
    status: current ? "True" : "False",
    requirement: "advisory",
    reason: current ? "ConfigCurrent" : "ConfigRestartRequired",
    message: current
      ? "The active runtime uses the current source configuration generation."
      : "The source configuration has changes that are not active in this runtime.",
  };
}

export function buildSecretsReadyCondition(
  owners: readonly DegradedSecretOwner[] = listActiveDegradedSecretOwners(),
): ReadinessCondition {
  if (owners.length === 0) {
    return {
      type: "SecretsReady",
      status: "True",
      requirement: "advisory",
      reason: "SecretsReady",
      message: "No active runtime owner is degraded by secret resolution.",
    };
  }
  const kinds = [...new Set(owners.map((owner) => owner.ownerKind))].toSorted();
  return {
    type: "SecretsReady",
    status: "False",
    requirement: "advisory",
    reason: "SecretOwnersUnavailable",
    message: `${owners.length} active runtime owner(s) are degraded by secret resolution (${kinds.join(", ")}).`,
  };
}

export function buildModelRouteReadyCondition(
  config: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
  sources: ModelRouteReadinessSources = {
    listOwners: listConfiguredOwnerInputs,
    getSnapshot: getPreparedModelRuntimeSnapshot,
    getProviderAuthStates: getCurrentProviderAuthStates,
  },
): ReadinessCondition {
  const owners = sources.listOwners(config);
  const defaultAgentId = resolveDefaultAgentId(config);
  const defaultOwner = owners.find((owner) => owner.agentId === defaultAgentId);
  if (!defaultOwner) {
    return unknownCondition(
      "ModelRouteReady",
      "ModelRuntimeSnapshotUnavailable",
      "The default agent runtime owner is not available.",
    );
  }
  const snapshot = sources.getSnapshot({
    ...defaultOwner,
    workspaceDir: undefined,
    env,
  });
  if (!snapshot) {
    return unknownCondition(
      "ModelRouteReady",
      "ModelRuntimeSnapshotUnavailable",
      "The prepared model runtime generation is not available.",
    );
  }
  if (snapshot.modelCatalog.authoritative === false) {
    return unknownCondition(
      "ModelRouteReady",
      "ModelCatalogUnavailable",
      "The prepared model catalog is not authoritative.",
    );
  }
  const model = resolveDefaultModelForAgent({
    cfg: snapshot.config,
    agentId: snapshot.agentId,
    allowPluginNormalization: true,
    manifestPlugins: snapshot.metadataSnapshot.plugins,
  });
  const entry = findModelInCatalog(snapshot.modelCatalog.entries, model.provider, model.model);
  if (!entry) {
    return {
      type: "ModelRouteReady",
      status: "False",
      requirement: "advisory",
      reason: "ModelRouteUnavailable",
      message: "The configured default model is not present in the active model catalog.",
    };
  }
  const authState = sources.getProviderAuthStates()?.get(defaultAgentId);
  if (!authState || authState.configFingerprint !== hashRuntimeConfigValue(snapshot.config)) {
    return unknownCondition(
      "ModelRouteReady",
      "ModelAuthStatusUnavailable",
      "Published authentication status for the configured default model is unavailable.",
    );
  }
  const route = authState.defaultModelRoute;
  if (
    !route ||
    route.provider !== normalizeProviderId(entry.provider) ||
    route.modelId !== entry.id.trim().toLowerCase()
  ) {
    return unknownCondition(
      "ModelRouteReady",
      "ModelAuthStatusUnavailable",
      "Published authentication status for the configured default model is unavailable.",
    );
  }
  return {
    type: "ModelRouteReady",
    status: route.available ? "True" : "False",
    requirement: "advisory",
    reason: route.available ? "ModelRouteReady" : "ModelAuthUnavailable",
    message: route.available
      ? "The configured default model route has available authentication."
      : "Authentication is unavailable for the configured default model route.",
  };
}

function createDefaultDeps(): ActivationReadinessDeps {
  return {
    configCurrent: buildConfigCurrentCondition,
    modelRouteReady: buildModelRouteReadyCondition,
    secretsReady: buildSecretsReadyCondition,
  };
}

export function createActivationReadinessResolver(
  deps: ActivationReadinessDeps = createDefaultDeps(),
) {
  return (params: {
    config: OpenClawConfig;
    criterionIds: ReadonlySet<string>;
    env?: NodeJS.ProcessEnv;
  }): Map<ActivationReadinessCriterionId, ReadinessCondition> => {
    const conditions = new Map<ActivationReadinessCriterionId, ReadinessCondition>();
    const evaluate = (
      id: ActivationReadinessCriterionId,
      type: string,
      check: () => ReadinessCondition,
    ) => {
      if (!params.criterionIds.has(id)) {
        return;
      }
      try {
        conditions.set(id, check());
      } catch {
        conditions.set(
          id,
          unknownCondition(
            type,
            "CriterionEvaluationFailed",
            "The readiness criterion could not inspect its runtime snapshot.",
          ),
        );
      }
    };
    evaluate(CONFIG_CURRENT_CRITERION_ID, "ConfigCurrent", () => deps.configCurrent());
    evaluate(MODEL_ROUTE_READY_CRITERION_ID, "ModelRouteReady", () =>
      deps.modelRouteReady(params.config, params.env),
    );
    evaluate(SECRETS_READY_CRITERION_ID, "SecretsReady", () => deps.secretsReady());
    return conditions;
  };
}
