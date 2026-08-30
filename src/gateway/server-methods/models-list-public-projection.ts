import { buildModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { asPositiveSafeInteger as resolvePositiveSafeInteger } from "@openclaw/normalization-core/number-coercion";
import type {
  ModelCatalogProviderOutcome,
  ModelChoice,
} from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import type { resolveConfiguredModelEntries } from "../../agents/configured-model-entries.js";
import { resolveFastModeState } from "../../agents/fast-mode.js";
import { resolveAgentHarnessPolicy } from "../../agents/harness/policy.js";
import type { ModelAuthAvailabilityEvaluation } from "../../agents/model-auth-availability.js";
import { hasSyntheticLocalProviderAuthConfig } from "../../agents/model-auth-provider-config.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ProviderCatalogOutcome } from "../../plugins/provider-catalog.types.js";
import type { GatewayAgentRuntime } from "../../shared/session-types.js";
import { resolveGatewayModelThinkingProfile } from "../session-utils-model.js";
import { projectWorkerPlacementAgentRuntime } from "../worker-environments/placement-session-runtime.js";
import type { resolveModelProviderCapabilities } from "./model-provider-capabilities.js";

type ModelsListEntry = Pick<
  ModelChoice,
  | "alias"
  | "contextWindow"
  | "contextWindowDefault"
  | "contextWindows"
  | "id"
  | "input"
  | "name"
  | "provider"
  | "reasoning"
  | "tags"
> & { available?: boolean; supportsTools?: boolean };

/** Keeps concrete route, auth, cost, and provider parameters out of public model rows. */
function buildPublicModelProjection(entry: ModelCatalogEntry): ModelsListEntry {
  const contextWindow = resolvePositiveSafeInteger(entry.contextWindow);
  return {
    id: entry.id,
    name: entry.name,
    provider: entry.provider,
    ...(entry.alias ? { alias: entry.alias } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(entry.contextWindows ? { contextWindows: entry.contextWindows } : {}),
    ...(entry.contextWindowDefault ? { contextWindowDefault: entry.contextWindowDefault } : {}),
    ...(typeof entry.reasoning === "boolean" ? { reasoning: entry.reasoning } : {}),
    ...(typeof entry.compat?.supportsTools === "boolean"
      ? { supportsTools: entry.compat.supportsTools }
      : {}),
  };
}

export function projectProviderCatalogOutcomes(
  outcomes: readonly ProviderCatalogOutcome[] | undefined,
): readonly ModelCatalogProviderOutcome[] | undefined {
  return outcomes?.map(({ provider, profileId, status }) => ({
    provider,
    ...(profileId ? { profileId } : {}),
    status,
  }));
}

function resolveModelChoiceAgentRuntime(params: {
  cfg: OpenClawConfig;
  agentId: string;
  entry: ModelCatalogEntry;
}): GatewayAgentRuntime | undefined {
  const harnessPolicy = resolveAgentHarnessPolicy({
    provider: params.entry.provider,
    modelId: params.entry.id,
    modelApi: params.entry.api,
    modelBaseUrl: params.entry.baseUrl,
    config: params.cfg,
    agentId: params.agentId,
  });
  if (harnessPolicy.runtime === "auto") {
    return undefined;
  }
  return projectWorkerPlacementAgentRuntime({
    id: harnessPolicy.runtime,
    source: harnessPolicy.runtimeSource ?? "implicit",
  });
}

export function createPublicModelsListProjector(params: {
  thinkingCatalog: ModelCatalogEntry[];
  cfg: OpenClawConfig;
  agentId: string;
  configuredEntriesByKey: ReturnType<typeof resolveConfiguredModelEntries>["byKey"];
  includeInput?: boolean;
  preserveUnknownAvailability?: boolean;
  apiKeyCapabilities?: ReturnType<typeof resolveModelProviderCapabilities>;
}) {
  const apiKeyCapabilities = params.apiKeyCapabilities;
  const apiKeyProviders = apiKeyCapabilities
    ? new Map(
        apiKeyCapabilities.capabilities.map(({ provider, apiKeySupported }) => [
          provider,
          apiKeySupported,
        ]),
      )
    : undefined;
  // Route rows retain identity across reads; keep display/thinking work outside the hot overlay.
  const prepared = new WeakMap<ModelCatalogEntry, ModelChoice>();
  return (entry: ModelCatalogEntry, evaluation: ModelAuthAvailabilityEvaluation): ModelChoice => {
    let preparedEntry = prepared.get(entry);
    if (!preparedEntry) {
      const configuredEntry = params.configuredEntriesByKey.get(
        buildModelCatalogRef(entry.provider, entry.id),
      );
      const alias = configuredEntry?.aliases.at(-1);
      const publicEntry = configuredEntry?.aliasDisabled
        ? Object.assign({}, entry, { alias: undefined })
        : alias && alias !== entry.alias
          ? Object.assign({}, entry, { alias })
          : entry;
      const capabilityProvider = apiKeyCapabilities?.resolveProvider(entry.provider);
      const agentRuntime = resolveModelChoiceAgentRuntime({
        cfg: params.cfg,
        agentId: params.agentId,
        entry,
      });
      const thinkingProfile =
        typeof publicEntry.reasoning !== "boolean"
          ? undefined
          : resolveGatewayModelThinkingProfile({
              cfg: params.cfg,
              agentId: params.agentId,
              provider: entry.provider,
              model: entry.id,
              modelCatalog: params.thinkingCatalog,
              configuredReasoning: publicEntry.configuredReasoning ?? publicEntry.reasoning,
              thinkingPolicyProvider: publicEntry.thinkingPolicyProvider,
            });
      const fastModeState = resolveFastModeState({
        cfg: params.cfg,
        agentId: params.agentId,
        provider: entry.provider,
        model: entry.id,
      });
      preparedEntry = {
        ...buildPublicModelProjection(publicEntry),
        ...(configuredEntry?.tags.size ? { tags: [...configuredEntry.tags] } : {}),
        ...(agentRuntime ? { agentRuntime } : {}),
        ...thinkingProfile,
        ...(fastModeState.source === "default" ? {} : { effectiveFastMode: fastModeState.mode }),
        ...(capabilityProvider && apiKeyProviders?.has(capabilityProvider)
          ? {
              apiKeySupported: apiKeyProviders.get(capabilityProvider) === true,
            }
          : {}),
        ...(params.includeInput && entry.input?.length ? { input: entry.input } : {}),
      };
      prepared.set(entry, preparedEntry);
    }
    const syntheticLocalAvailable =
      evaluation.availability === undefined &&
      evaluation.routeResolution === null &&
      normalizeProviderId(entry.provider) !== "openai" &&
      hasSyntheticLocalProviderAuthConfig({ cfg: params.cfg, provider: entry.provider });
    const available = evaluation.availability ?? (syntheticLocalAvailable ? true : undefined);
    // Legacy views require a boolean; inventory consumers preserve unknown state.
    const projectedAvailability = params.preserveUnknownAvailability
      ? available
      : (available ?? false);
    return Object.assign(
      {},
      preparedEntry,
      projectedAvailability === undefined ? {} : { available: projectedAvailability },
      projectedAvailability === false && evaluation.unavailableReason
        ? {
            unavailableReason: evaluation.unavailableReason,
            ...(evaluation.unavailableUntil !== undefined
              ? { unavailableUntil: evaluation.unavailableUntil }
              : {}),
          }
        : {},
    );
  };
}
