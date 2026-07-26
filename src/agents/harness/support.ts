import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import {
  resolveMergedModelProviderConfig,
  resolveMergedModelProviderModels,
  resolveModelProviderRouteOverridePresence,
} from "../../config/model-provider-config.js";
import type { ModelApi } from "../../config/types.models.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type {
  ProviderModelRouteRuntimePolicy,
  ProviderRouteOverridePresence,
} from "../../plugin-sdk/provider-model-types.js";
import { resolveProviderModelRoutes } from "../../plugins/provider-model-routes.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { hasModelExtraParams } from "../model-extra-params.js";
import { canonicalizeProviderModelId } from "../provider-model-route.js";
import type { AgentRuntimeAuthPlan } from "../runtime-plan/types.js";
import { resolveAgentHarnessAutoSelectionHint } from "./auto-selection.js";
import { listRegisteredAgentHarnesses } from "./registry.js";
import type {
  AgentHarness,
  AgentHarnessPreparedAuthSupport,
  AgentHarnessSupport,
  AgentHarnessSupportContext,
} from "./types.js";

type HarnessProviderOwnership =
  | { status: "unowned" }
  | { status: "owned" | "ambiguous"; pluginIds: readonly string[] };

/** Projects one prepared auth attempt into a secret-free native-runtime support fact. */
export function resolveAgentHarnessPreparedAuthSupport(params: {
  plan?: AgentRuntimeAuthPlan;
  source?: AgentHarnessPreparedAuthSupport["source"];
}): AgentHarnessPreparedAuthSupport | undefined {
  const plan = params.plan;
  if (!plan) {
    return undefined;
  }
  const source =
    params.source ??
    (plan.forwardedAuthProfileId
      ? "profile"
      : plan.selectedAuthMode
        ? "direct"
        : plan.harnessAuthProvider
          ? "harness"
          : "none");
  return {
    source,
    ...(plan.selectedAuthMode ? { mode: plan.selectedAuthMode } : {}),
    ...(plan.modelRoute ? { requirement: plan.modelRoute.authRequirement } : {}),
  };
}

/** Projects the concrete or deferred prepared route into native-runtime support facts. */
export function resolveAgentHarnessPreparedRouteSupport(
  plan?: AgentRuntimeAuthPlan,
): Pick<
  NonNullable<AgentHarnessSupportContext["modelProvider"]>,
  "requestTransportOverrides" | "runtimePolicy"
> {
  const support = plan?.modelRoute ?? plan?.deferredRouteSupport;
  return support
    ? {
        requestTransportOverrides: support.requestTransportOverrides,
        runtimePolicy: support.runtimePolicy,
      }
    : {};
}

/** Builds the provider/model facts passed to registered harness support probes. */
export function buildAgentHarnessSupportContext(params: {
  provider: string;
  modelId?: string;
  /** Prepared provider facts take precedence over config rediscovery. */
  modelProvider?: AgentHarnessSupportContext["modelProvider"];
  requestedRuntime: AgentHarnessSupportContext["requestedRuntime"];
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  /** Finalized route/auth selection; missing runtimePolicy stays undeclared. */
  preparedModelProvider?: boolean;
  /** Prepared selection fact; read-only projections omit it to avoid plugin metadata discovery. */
  providerOwnership?: HarnessProviderOwnership;
}): AgentHarnessSupportContext {
  const providerConfig = resolveMergedModelProviderConfig(params.config, params.provider);
  const modelId = params.modelId ? normalizeModelId(params.provider, params.modelId) : undefined;
  const modelConfig = modelId
    ? resolveMergedModelProviderModels({
        models: providerConfig?.models,
        normalizeModelId: (configuredModelId) =>
          normalizeModelId(params.provider, configuredModelId),
      }).get(modelId)
    : undefined;
  const agentId =
    params.agentId ??
    (params.sessionKey ? resolveAgentIdFromSessionKey(params.sessionKey) : undefined);
  const hasConfiguredParams = hasModelExtraParams({
    config: params.config,
    provider: params.provider,
    modelId: params.modelId,
    agentId,
  });
  const configuredModelProvider = providerConfig
    ? {
        api: modelConfig?.api ?? providerConfig.api ?? "openai-responses",
        baseUrl: modelConfig?.baseUrl ?? providerConfig.baseUrl,
        azureApiVersion: readStringParam(
          modelConfig?.params?.azureApiVersion ?? providerConfig.params?.azureApiVersion,
        ),
        request: providerConfig.request,
        requestTransportOverrides: resolveModelProviderRouteOverridePresence({
          provider: params.provider,
          modelId: params.modelId,
          config: params.config,
          canonicalizeModelId: (configuredModelId) =>
            canonicalizeProviderModelId(params.provider, configuredModelId),
        }),
      }
    : undefined;
  const requestTransportOverrides: ProviderRouteOverridePresence =
    params.modelProvider?.requestTransportOverrides === "present" ||
    configuredModelProvider?.requestTransportOverrides === "present" ||
    hasConfiguredParams
      ? "present"
      : "none";
  const modelProviderFacts =
    params.modelProvider || configuredModelProvider || hasConfiguredParams
      ? {
          api: params.modelProvider?.api ?? configuredModelProvider?.api,
          baseUrl: params.modelProvider?.baseUrl ?? configuredModelProvider?.baseUrl,
          azureApiVersion:
            params.modelProvider?.azureApiVersion ?? configuredModelProvider?.azureApiVersion,
          request: params.modelProvider?.request ?? configuredModelProvider?.request,
          preparedAuth: params.modelProvider?.preparedAuth,
          requestTransportOverrides,
        }
      : undefined;
  // Finalized routes carry the owner decision. Earlier selection resolves the same provider
  // artifact once so an indeterminate route cannot regain provider-id-only native support.
  const routeRuntimeContract = params.modelProvider?.runtimePolicy
    ? { owned: true, policy: params.modelProvider.runtimePolicy }
    : params.preparedModelProvider
      ? { owned: true }
      : resolveHarnessRouteRuntimePolicy({
          provider: params.provider,
          modelId: params.modelId,
          modelProvider: modelProviderFacts,
          config: params.config,
        });
  const modelProvider =
    modelProviderFacts || routeRuntimeContract.owned
      ? {
          ...modelProviderFacts,
          runtimePolicy: params.modelProvider?.runtimePolicy ?? routeRuntimeContract.policy,
        }
      : undefined;
  return {
    provider: params.provider,
    modelId: params.modelId,
    modelProvider,
    requestedRuntime: params.requestedRuntime,
    ...(params.providerOwnership
      ? {
          providerOwnerStatus: params.providerOwnership.status,
          providerOwnerPluginIds:
            params.providerOwnership.status === "unowned" ? [] : params.providerOwnership.pluginIds,
        }
      : {}),
  };
}

function resolveHarnessRouteRuntimePolicy(params: {
  provider: string;
  modelId?: string;
  modelProvider?: AgentHarnessSupportContext["modelProvider"];
  config?: OpenClawConfig;
}): { owned: boolean; policy?: ProviderModelRouteRuntimePolicy } {
  const resolution = resolveProviderModelRoutes({
    provider: params.provider,
    modelId: params.modelId,
    api: params.modelProvider?.api as ModelApi | undefined,
    baseUrl: params.modelProvider?.baseUrl,
    config: params.config,
    requestTransportOverrides: params.modelProvider?.requestTransportOverrides,
  });
  if (!resolution) {
    return { owned: false };
  }
  if (resolution.kind !== "routes") {
    return { owned: true };
  }
  const policies = resolution.routes.map((route) => route.runtimePolicy);
  const first = policies[0];
  if (!first || policies.some((policy) => !policy)) {
    return { owned: true };
  }
  return {
    owned: true,
    policy: {
      compatibleIds: first.compatibleIds.filter(
        (id, index, ids) =>
          ids.indexOf(id) === index &&
          policies.every((policy) => policy?.compatibleIds.includes(id)),
      ),
    },
  };
}

/** Resolves the registered plugin harness that auto selection would choose. */
export function resolveAutoAgentHarnessId(params: {
  provider: string;
  modelId?: string;
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
}): string | undefined {
  const registeredHarnesses = listRegisteredAgentHarnesses();
  if (registeredHarnesses.length === 0) {
    return undefined;
  }
  const candidates = registeredHarnesses.map(({ harness }) => ({
    harness,
    support: resolveAgentHarnessAutoSelectionHint({ harness, provider: params.provider }),
  }));
  if (candidates.every((entry) => entry.support !== undefined)) {
    return undefined;
  }
  const supportContext = buildAgentHarnessSupportContext({
    ...params,
    requestedRuntime: "auto",
  });
  return candidates
    .map(({ harness, support }) => ({
      harness,
      support: support ?? harness.supports(supportContext),
    }))
    .filter(isSupportedHarness)
    .toSorted(compareHarnessSupport)[0]?.harness.id;
}

export function compareHarnessSupport(
  left: { harness: AgentHarness; support: AgentHarnessSupport & { supported: true } },
  right: { harness: AgentHarness; support: AgentHarnessSupport & { supported: true } },
): number {
  const priorityDelta = (right.support.priority ?? 0) - (left.support.priority ?? 0);
  return priorityDelta !== 0 ? priorityDelta : left.harness.id.localeCompare(right.harness.id);
}

function isSupportedHarness(entry: {
  harness: AgentHarness;
  support: AgentHarnessSupport;
}): entry is {
  harness: AgentHarness;
  support: AgentHarnessSupport & { supported: true };
} {
  return entry.support.supported;
}

function readStringParam(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeModelId(provider: string, modelId: string): string {
  const trimmed = modelId.trim();
  const slashIndex = trimmed.indexOf("/");
  const unqualified =
    slashIndex > 0 &&
    normalizeProviderId(trimmed.slice(0, slashIndex)) === normalizeProviderId(provider)
      ? trimmed.slice(slashIndex + 1).trim()
      : trimmed;
  return canonicalizeProviderModelId(provider, unqualified);
}
