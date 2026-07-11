// Openai API module exposes the plugin public contract.
import type { ProviderDefaultThinkingPolicyContext } from "openclaw/plugin-sdk/core";
import type {
  ModelApi,
  ModelProviderConfig,
  ProviderModelRouteCandidate,
  ProviderModelRouteResolution,
  ProviderModelRouteSource,
  ProviderNormalizeModelCatalogIdContext,
  ProviderResolveModelRoutesContext,
} from "openclaw/plugin-sdk/provider-model-types";
import {
  classifyOpenAIBaseUrl,
  OPENAI_API_BASE_URL,
  OPENAI_CODEX_RESPONSES_BASE_URL,
} from "./base-url.js";
import {
  isOpenAIDualRouteModelId,
  isOpenAIPlatformOnlyRouteModelId,
  isOpenAISubscriptionOnlyRouteModelId,
  normalizeOpenAIModelRouteId,
} from "./model-route-contract.js";
import { resolveUnifiedOpenAIThinkingProfile } from "./thinking-policy.js";

const OPENAI_RESPONSES_API = "openai-responses";
const OPENAI_COMPLETIONS_API = "openai-completions";
const OPENAI_CHATGPT_RESPONSES_API = "openai-chatgpt-responses";
const OPENAI_AGENT_RUNTIME_ID = "openclaw";
const CODEX_AGENT_RUNTIME_ID = "codex";
const OPENCLAW_RUNTIME_COMPATIBLE_IDS = [OPENAI_AGENT_RUNTIME_ID] as const;
const CODEX_RUNTIME_COMPATIBLE_IDS = [OPENAI_AGENT_RUNTIME_ID, CODEX_AGENT_RUNTIME_ID] as const;

type OpenAIResolveSingleModelRouteContext = Omit<
  ProviderResolveModelRoutesContext,
  "observedRoutes"
> & {
  observed?: ProviderModelRouteSource;
};

function normalizeOptionalRouteApi(value: ModelApi | null | undefined): ModelApi | undefined {
  return typeof value === "string" && value.trim() ? (value.trim() as ModelApi) : undefined;
}

function normalizeOptionalRouteBaseUrl(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Canonical logical id for OpenAI catalog projection. */
export function normalizeModelCatalogId(params: ProviderNormalizeModelCatalogIdContext) {
  return params.provider.trim().toLowerCase() === "openai"
    ? normalizeOpenAIModelRouteId(params.modelId)
    : null;
}

function firstRouteBaseUrl(...values: unknown[]): unknown {
  for (const value of values) {
    if (typeof value === "string") {
      if (value.trim()) {
        return value.trim();
      }
      continue;
    }
    if (value !== undefined && value !== null) {
      return value;
    }
  }
  return undefined;
}

function concreteBaseUrl(value: unknown, fallback: string): string {
  return normalizeOptionalRouteBaseUrl(value) ?? fallback;
}

function resolveOpenAIEnvironmentBaseUrl(
  context: Pick<ProviderResolveModelRoutesContext, "env">,
): string | undefined {
  return (context.env ?? process.env).OPENAI_BASE_URL;
}

function isHttpBaseUrl(baseUrl: unknown): boolean {
  if (typeof baseUrl !== "string") {
    return false;
  }
  try {
    return new URL(baseUrl.trim()).protocol === "http:";
  } catch {
    return false;
  }
}

function codexCanReproduceRoute(
  candidate: ProviderModelRouteCandidate,
  sourceBaseUrl: unknown = candidate.baseUrl,
): boolean {
  // Official HTTP ChatGPT input normalizes to the native HTTPS candidate. Retain the source
  // protocol here so normalization cannot silently make an unreproducible route Codex-compatible.
  if (isHttpBaseUrl(sourceBaseUrl) || candidate.requestTransportOverrides === "present") {
    return false;
  }
  const endpointKind = classifyOpenAIBaseUrl(candidate.baseUrl);
  return (
    (candidate.api === OPENAI_RESPONSES_API && endpointKind === "platform") ||
    (candidate.api === OPENAI_CHATGPT_RESPONSES_API && endpointKind === "chatgpt")
  );
}

function withRuntimePolicy(
  candidate: ProviderModelRouteCandidate,
  sourceBaseUrl: unknown = candidate.baseUrl,
): ProviderModelRouteCandidate {
  return {
    ...candidate,
    runtimePolicy: {
      compatibleIds: codexCanReproduceRoute(candidate, sourceBaseUrl)
        ? CODEX_RUNTIME_COMPATIBLE_IDS
        : OPENCLAW_RUNTIME_COMPATIBLE_IDS,
    },
  };
}

function defaultRuntimeIdForRoute(
  candidate: ProviderModelRouteCandidate,
  sourceBaseUrl: unknown = candidate.baseUrl,
): string {
  return codexCanReproduceRoute(candidate, sourceBaseUrl)
    ? CODEX_AGENT_RUNTIME_ID
    : OPENAI_AGENT_RUNTIME_ID;
}

function route(
  candidate: ProviderModelRouteCandidate,
  sourceBaseUrl?: unknown,
): ProviderModelRouteResolution & { kind: "routes" } {
  const compatibleCandidate = withRuntimePolicy(candidate, sourceBaseUrl);
  return {
    kind: "routes",
    routes: [compatibleCandidate],
    defaultRuntimeId: defaultRuntimeIdForRoute(compatibleCandidate, sourceBaseUrl),
  };
}

/**
 * Resolves OpenAI transport policy in provider-default order.
 *
 * Candidate order is not credential order. Callers must honor a locked profile,
 * provider auth, then auth.order before choosing a compatible candidate. Unknown
 * models without route facts remain indeterminate until a catalog row is observed.
 */
function resolveSingleObservedModelRoute(
  context: OpenAIResolveSingleModelRouteContext,
): ProviderModelRouteResolution {
  if (context.provider.trim().toLowerCase() !== "openai") {
    return {
      kind: "incompatible",
      code: "openai-route-provider-mismatch",
      message: `OpenAI route policy cannot resolve provider ${context.provider || "(empty)"}.`,
    };
  }
  const modelApi = normalizeOptionalRouteApi(context.configuredModel?.api);
  const requestTransportOverrides = context.requestTransportOverrides ?? "none";
  const providerApi = normalizeOptionalRouteApi(context.configuredProvider?.api);
  const modelBaseUrl = firstRouteBaseUrl(context.configuredModel?.baseUrl);
  const providerBaseUrl = firstRouteBaseUrl(context.configuredProvider?.baseUrl);
  const environmentBaseUrl = firstRouteBaseUrl(resolveOpenAIEnvironmentBaseUrl(context));
  const observedApi = normalizeOptionalRouteApi(context.observed?.api);
  const observedBaseUrl = firstRouteBaseUrl(context.observed?.baseUrl);
  const hasObservedRoute = observedApi !== undefined || observedBaseUrl !== undefined;
  let effectiveApi: ModelApi | undefined;
  let effectiveBaseUrl: unknown;
  let configuredRoute = false;
  let customDefaultApi: ModelApi = OPENAI_COMPLETIONS_API;

  // Model facts override provider facts field-by-field, which override the environment.
  // Observed rows are atomic fallback only; custom bases may inherit a lower
  // authored adapter without combining contradictory official transports.
  if (modelApi !== undefined || modelBaseUrl !== undefined) {
    configuredRoute = true;
    effectiveApi = modelApi ?? providerApi;
    effectiveBaseUrl = modelBaseUrl;
    if (modelBaseUrl === undefined) {
      const lowerBaseUrl = providerBaseUrl ?? environmentBaseUrl;
      const lowerEndpointKind = classifyOpenAIBaseUrl(lowerBaseUrl);
      effectiveBaseUrl =
        lowerEndpointKind === "custom" || lowerEndpointKind === "invalid"
          ? lowerBaseUrl
          : undefined;
    }
  } else if (providerApi !== undefined || providerBaseUrl !== undefined) {
    configuredRoute = true;
    effectiveApi = providerApi;
    effectiveBaseUrl = providerBaseUrl;
    if (providerBaseUrl === undefined) {
      const environmentEndpointKind = classifyOpenAIBaseUrl(environmentBaseUrl);
      if (environmentEndpointKind === "custom" || environmentEndpointKind === "invalid") {
        effectiveBaseUrl = environmentBaseUrl;
      }
    }
  } else if (environmentBaseUrl !== undefined) {
    configuredRoute = true;
    effectiveBaseUrl = environmentBaseUrl;
    customDefaultApi = OPENAI_RESPONSES_API;
  } else {
    effectiveApi = observedApi;
    effectiveBaseUrl = observedBaseUrl;
  }
  const endpointKind = classifyOpenAIBaseUrl(effectiveBaseUrl);
  if (endpointKind === "invalid") {
    return {
      kind: "incompatible",
      code: "invalid-openai-base-url",
      message: "OpenAI model route baseUrl must be a non-empty URL string.",
    };
  }
  const chatGPTApi = effectiveApi?.toLowerCase() === OPENAI_CHATGPT_RESPONSES_API;
  const authoredChatGPTApi =
    modelApi?.toLowerCase() === OPENAI_CHATGPT_RESPONSES_API ||
    providerApi?.toLowerCase() === OPENAI_CHATGPT_RESPONSES_API;

  // A custom endpoint owns its protocol contract. Subscription egress always
  // requires authored ChatGPT intent; observed Platform adapters remain safe
  // API-key fallbacks for otherwise unspecified custom routes.
  if (endpointKind === "custom") {
    if (chatGPTApi && !authoredChatGPTApi) {
      return {
        kind: "incompatible",
        code: "custom-chatgpt-relay-requires-configuration",
        message: "Custom ChatGPT relays require an explicitly configured ChatGPT adapter.",
      };
    }
    // An independently authored custom endpoint may reuse only observed
    // Platform adapters. Requiring authored ChatGPT intent prevents a stale
    // catalog row from redirecting a subscription bearer to that endpoint.
    const observedPlatformApi =
      observedApi === OPENAI_RESPONSES_API || observedApi === OPENAI_COMPLETIONS_API
        ? observedApi
        : undefined;
    const customApi = effectiveApi ?? observedPlatformApi ?? customDefaultApi;
    if (
      customApi !== OPENAI_RESPONSES_API &&
      customApi !== OPENAI_COMPLETIONS_API &&
      customApi !== OPENAI_CHATGPT_RESPONSES_API
    ) {
      return {
        kind: "incompatible",
        code: "unsupported-custom-openai-api",
        message: `${customApi} is not an OpenAI-compatible model adapter.`,
      };
    }
    const customAuthRequirement =
      customApi.toLowerCase() === OPENAI_CHATGPT_RESPONSES_API ? "subscription" : "api-key";
    return route(
      {
        api: customApi,
        baseUrl: concreteBaseUrl(effectiveBaseUrl, OPENAI_API_BASE_URL),
        authRequirement: customAuthRequirement,
        requestTransportOverrides,
      },
      effectiveBaseUrl,
    );
  }

  if (
    (endpointKind === "platform" && chatGPTApi) ||
    (endpointKind === "chatgpt" && effectiveApi !== undefined && !chatGPTApi)
  ) {
    return {
      kind: "incompatible",
      code: "conflicting-official-openai-route",
      message: "OpenAI model API and baseUrl select different official transports.",
    };
  }

  if (
    effectiveApi !== undefined &&
    effectiveApi !== OPENAI_RESPONSES_API &&
    effectiveApi !== OPENAI_COMPLETIONS_API &&
    effectiveApi !== OPENAI_CHATGPT_RESPONSES_API
  ) {
    return {
      kind: "incompatible",
      code: "unsupported-official-openai-api",
      message: `${effectiveApi} is not an OpenAI Platform model adapter.`,
    };
  }

  const modelId = normalizeOpenAIModelRouteId(context.modelId);
  const sourceBaseUrl = effectiveBaseUrl;
  // An authored Completions adapter is a concrete transport contract, not an
  // alias for Responses. Codex does not execute that adapter, so preserve it
  // and let the OpenClaw runtime own the request.
  const platformApi =
    configuredRoute && effectiveApi === OPENAI_COMPLETIONS_API
      ? OPENAI_COMPLETIONS_API
      : OPENAI_RESPONSES_API;
  const platformRoute = withRuntimePolicy(
    {
      api: platformApi,
      baseUrl:
        classifyOpenAIBaseUrl(sourceBaseUrl) === "platform" && isHttpBaseUrl(sourceBaseUrl)
          ? concreteBaseUrl(sourceBaseUrl, OPENAI_API_BASE_URL)
          : OPENAI_API_BASE_URL,
      authRequirement: "api-key",
      requestTransportOverrides,
    },
    sourceBaseUrl,
  );
  const chatGPTRoute = withRuntimePolicy(
    {
      api: OPENAI_CHATGPT_RESPONSES_API,
      baseUrl: OPENAI_CODEX_RESPONSES_BASE_URL,
      authRequirement: "subscription",
      requestTransportOverrides,
    },
    sourceBaseUrl,
  );
  const platformOnly = isOpenAIPlatformOnlyRouteModelId(modelId);
  const subscriptionOnly = isOpenAISubscriptionOnlyRouteModelId(modelId);
  const dualRoute = isOpenAIDualRouteModelId(modelId);

  // Observed catalog transport is not authored route intent. Known model
  // contracts stay stable regardless of which official sibling row was seen.
  if (!configuredRoute) {
    if (subscriptionOnly) {
      return route(chatGPTRoute, sourceBaseUrl);
    }
    if (platformOnly) {
      return route(platformRoute, sourceBaseUrl);
    }
    if (dualRoute) {
      return {
        kind: "routes",
        defaultRuntimeId: defaultRuntimeIdForRoute(platformRoute, sourceBaseUrl),
        routes: [platformRoute, chatGPTRoute],
      };
    }
  }

  if (endpointKind === "chatgpt" || chatGPTApi) {
    if (platformOnly) {
      return {
        kind: "incompatible",
        code: "platform-only-model-on-chatgpt",
        message: `${modelId} is available only through OpenAI Platform API-key authentication.`,
      };
    }
    return route(chatGPTRoute, sourceBaseUrl);
  }

  if (subscriptionOnly) {
    return {
      kind: "incompatible",
      code: "subscription-only-model-on-platform",
      message: `${modelId} is available only through ChatGPT subscription authentication.`,
    };
  }

  if (!configuredRoute && !hasObservedRoute) {
    return {
      kind: "indeterminate",
      defaultRuntimeId:
        requestTransportOverrides === "present" ? OPENAI_AGENT_RUNTIME_ID : CODEX_AGENT_RUNTIME_ID,
    };
  }
  return route(platformRoute, sourceBaseUrl);
}

function hasAuthoredRouteFacts(context: ProviderResolveModelRoutesContext): boolean {
  return (
    normalizeOptionalRouteApi(context.configuredModel?.api) !== undefined ||
    firstRouteBaseUrl(context.configuredModel?.baseUrl) !== undefined ||
    normalizeOptionalRouteApi(context.configuredProvider?.api) !== undefined ||
    firstRouteBaseUrl(context.configuredProvider?.baseUrl) !== undefined ||
    firstRouteBaseUrl(resolveOpenAIEnvironmentBaseUrl(context)) !== undefined
  );
}

function authoredRouteNeedsObservedPlatformApi(
  context: ProviderResolveModelRoutesContext,
): boolean {
  // Observations may fill only the missing protocol for an authored custom
  // endpoint. Complete authored routes must stay isolated from catalog rows.
  if (
    normalizeOptionalRouteApi(context.configuredModel?.api) !== undefined ||
    normalizeOptionalRouteApi(context.configuredProvider?.api) !== undefined
  ) {
    return false;
  }
  const authoredBaseUrl = firstRouteBaseUrl(
    context.configuredModel?.baseUrl,
    context.configuredProvider?.baseUrl,
    resolveOpenAIEnvironmentBaseUrl(context),
  );
  return classifyOpenAIBaseUrl(authoredBaseUrl) === "custom";
}

function canonicalRouteCandidateBaseUrl(baseUrl: string): string {
  // Catalog rows may spell one endpoint differently. A canonical grouping key
  // prevents observation order from creating a false route ambiguity.
  try {
    const url = new URL(baseUrl);
    url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
    return url.toString();
  } catch {
    return baseUrl;
  }
}

function routeCandidateKey(candidate: ProviderModelRouteCandidate): string {
  return [
    candidate.api,
    canonicalRouteCandidateBaseUrl(candidate.baseUrl),
    candidate.authRequirement,
    candidate.requestTransportOverrides,
    ...(candidate.runtimePolicy?.compatibleIds ?? []),
  ].join("\u0000");
}

function compareRouteCandidates(
  a: ProviderModelRouteCandidate,
  b: ProviderModelRouteCandidate,
): number {
  const authOrder = (candidate: ProviderModelRouteCandidate) =>
    candidate.authRequirement === "api-key" ? 0 : 1;
  return (
    authOrder(a) - authOrder(b) || a.api.localeCompare(b.api) || a.baseUrl.localeCompare(b.baseUrl)
  );
}

function ambiguousObservedRouteGroup(
  message: string,
): Extract<ProviderModelRouteResolution, { kind: "incompatible" }> {
  return { kind: "incompatible", code: "ambiguous-openai-route-group", message };
}

function resolveAuthoredObservedFallback(observedRoutes: readonly ProviderModelRouteSource[]):
  | { kind: "observed"; route?: ProviderModelRouteSource }
  | {
      kind: "incompatible";
      resolution: Extract<ProviderModelRouteResolution, { kind: "incompatible" }>;
    } {
  const platformApis = new Set<ModelApi>();
  for (const observed of observedRoutes) {
    const api = normalizeOptionalRouteApi(observed.api);
    if (!api || api === OPENAI_CHATGPT_RESPONSES_API) {
      continue;
    }
    if (api !== OPENAI_RESPONSES_API && api !== OPENAI_COMPLETIONS_API) {
      return {
        kind: "incompatible",
        resolution: {
          kind: "incompatible",
          code: "unsupported-custom-openai-api",
          message: `${api} is not an OpenAI-compatible model adapter.`,
        },
      };
    }
    platformApis.add(api);
  }
  if (platformApis.size > 1) {
    return {
      kind: "incompatible",
      resolution: ambiguousObservedRouteGroup(
        "Observed OpenAI routes disagree on the Platform adapter for an authored endpoint.",
      ),
    };
  }
  const api = [...platformApis][0];
  return { kind: "observed", ...(api ? { route: { api } } : {}) };
}

/** Resolves every physical row for one logical OpenAI model in provider order. */
export function resolveModelRoutes(
  context: ProviderResolveModelRoutesContext,
): ProviderModelRouteResolution {
  const observedRoutes = (context.observedRoutes ?? []).filter(
    (observed) => observed.api != null || observed.baseUrl != null,
  );
  if (hasAuthoredRouteFacts(context)) {
    if (authoredRouteNeedsObservedPlatformApi(context)) {
      const fallback = resolveAuthoredObservedFallback(observedRoutes);
      if (fallback.kind === "incompatible") {
        return fallback.resolution;
      }
      return resolveSingleObservedModelRoute({ ...context, observed: fallback.route });
    }
    return resolveSingleObservedModelRoute(context);
  }
  if (observedRoutes.length <= 1) {
    return resolveSingleObservedModelRoute({ ...context, observed: observedRoutes[0] });
  }

  const resolutions = observedRoutes.map((observed) =>
    resolveSingleObservedModelRoute({ ...context, observed }),
  );
  const incompatible = resolutions
    .filter((resolution) => resolution.kind === "incompatible")
    .toSorted((a, b) => a.code.localeCompare(b.code) || a.message.localeCompare(b.message))[0];
  if (incompatible) {
    return incompatible;
  }

  const routesByKey = new Map<string, ProviderModelRouteCandidate>();
  for (const resolution of resolutions) {
    if (resolution.kind !== "routes") {
      continue;
    }
    for (const candidate of resolution.routes) {
      const key = routeCandidateKey(candidate);
      const existing = routesByKey.get(key);
      if (!existing || candidate.baseUrl.localeCompare(existing.baseUrl) < 0) {
        routesByKey.set(key, candidate);
      }
    }
  }
  const routes = [...routesByKey.values()].toSorted(compareRouteCandidates);
  const authRequirements = new Set(routes.map((candidate) => candidate.authRequirement));
  if (routes.length > authRequirements.size) {
    return ambiguousObservedRouteGroup(
      "Observed OpenAI routes contain multiple endpoints for the same authentication class.",
    );
  }
  const firstRoute = routes[0];
  if (!firstRoute) {
    return resolveSingleObservedModelRoute(context);
  }
  return {
    kind: "routes",
    routes: routes as [ProviderModelRouteCandidate, ...ProviderModelRouteCandidate[]],
    defaultRuntimeId: resolutions.some(
      (resolution) => resolution.kind === "routes" && resolution.defaultRuntimeId === "openclaw",
    )
      ? OPENAI_AGENT_RUNTIME_ID
      : defaultRuntimeIdForRoute(firstRoute),
  };
}

export function normalizeConfig(params: { provider: string; providerConfig: ModelProviderConfig }) {
  return params.providerConfig;
}

export function resolveThinkingProfile(params: ProviderDefaultThinkingPolicyContext) {
  switch (params.provider.trim().toLowerCase()) {
    case "openai":
      return resolveUnifiedOpenAIThinkingProfile(
        params.modelId,
        params.agentRuntime,
        params.compat,
      );
    default:
      return null;
  }
}
