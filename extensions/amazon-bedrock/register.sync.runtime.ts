/**
 * Synchronous Amazon Bedrock provider registration. It wires Bedrock streaming,
 * model discovery, thinking policy, guardrails, and embedding integration.
 */
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { registerApiProvider, streamSimple } from "openclaw/plugin-sdk/llm";
import { resolvePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import type {
  OpenClawPluginApi,
  ProviderNormalizeResolvedModelContext,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  ANTHROPIC_BY_MODEL_REPLAY_HOOKS,
  normalizeProviderId,
  resolveClaudeFable5ModelIdentity,
  resolveClaudeModelIdentity,
  resolveClaudeMythos5ModelIdentity,
  resolveClaudeSonnet5ModelIdentity,
} from "openclaw/plugin-sdk/provider-model-shared";
import { streamWithPayloadPatch } from "openclaw/plugin-sdk/provider-stream-shared";
import { refreshAwsSharedConfigCacheForBedrock } from "./aws-credential-refresh.js";
import { supportsBedrockPromptCaching } from "./bedrock-options.js";
import { mergeImplicitBedrockProvider, resolveBedrockConfigApiKey } from "./discovery-shared.js";
import { bedrockMemoryEmbeddingProviderAdapter } from "./memory-embedding-adapter.js";
import { streamBedrock, streamSimpleBedrock } from "./stream.runtime.js";
import {
  isLatestAdaptiveBedrockModelRef,
  isOpus47OrNewerBedrockModelRef,
  resolveBedrockNativeThinkingLevelMap,
  resolveBedrockClaudeThinkingProfile,
  supportsBedrockNativeMaxEffort,
} from "./thinking-policy.js";

type GuardrailConfig = {
  guardrailIdentifier: string;
  guardrailVersion: string;
  streamProcessingMode?: "sync" | "async";
  trace?: "enabled" | "disabled" | "enabled_full";
};

type AmazonBedrockPluginConfig = {
  discovery?: {
    enabled?: boolean;
    region?: string;
    providerFilter?: string[];
    refreshInterval?: number;
    defaultContextWindow?: number;
    defaultMaxTokens?: number;
  };
  guardrail?: GuardrailConfig;
};

function normalizeBedrockResolvedModel({ modelId, model }: ProviderNormalizeResolvedModelContext) {
  const thinkingLevelMap = resolveBedrockNativeThinkingLevelMap(modelId, model.params);
  if (!thinkingLevelMap) {
    return undefined;
  }
  const reasoning =
    model.reasoning ||
    resolveClaudeFable5ModelIdentity({ id: modelId, params: model.params }) !== undefined ||
    resolveClaudeMythos5ModelIdentity({ id: modelId, params: model.params }) !== undefined;
  const current = model.thinkingLevelMap;
  const currentEfforts = current as Record<string, string | null | undefined> | undefined;
  if (
    reasoning === model.reasoning &&
    Object.entries(thinkingLevelMap).every(([level, effort]) => currentEfforts?.[level] === effort)
  ) {
    return undefined;
  }
  return {
    ...model,
    reasoning,
    thinkingLevelMap: { ...thinkingLevelMap, ...current },
  };
}

const BEDROCK_SERVICE_TIER_VALUES = ["flex", "priority", "default", "reserved"] as const;
type BedrockServiceTier = (typeof BEDROCK_SERVICE_TIER_VALUES)[number];

function isAnthropicBedrockModel(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase();
  if (normalized.includes("anthropic.claude") || normalized.includes("anthropic/claude")) {
    return true;
  }
  if (
    /^arn:aws(-cn|-us-gov)?:bedrock:/.test(normalized) &&
    normalized.includes(":application-inference-profile/")
  ) {
    const profileId = normalized.split(":application-inference-profile/")[1] ?? "";
    return profileId.includes("claude");
  }
  return false;
}

function createBedrockNoCacheWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) =>
    underlying(model, context, {
      ...options,
      cacheRetention: "none",
    });
}

function isBedrockServiceTier(value: string): value is BedrockServiceTier {
  return BEDROCK_SERVICE_TIER_VALUES.some((tier) => tier === value);
}

function resolveBedrockServiceTier(
  extraParams: Record<string, unknown> | undefined,
  warn: (message: string) => void,
): BedrockServiceTier | undefined {
  const raw = extraParams?.serviceTier ?? extraParams?.service_tier;
  if (typeof raw !== "string") {
    return undefined;
  }
  const normalized = raw.trim().toLowerCase();
  if (isBedrockServiceTier(normalized)) {
    return normalized;
  }
  warn(`ignoring invalid Bedrock service_tier param: ${raw}`);
  return undefined;
}

function createBedrockServiceTierWrapper(
  underlying: StreamFn,
  serviceTier: BedrockServiceTier,
): StreamFn {
  return (model, context, options) => {
    if (model.api !== "bedrock-converse-stream") {
      return underlying(model, context, options);
    }
    return streamWithPayloadPatch(underlying, model, context, options, (payloadObj) => {
      payloadObj.serviceTier ??= { type: serviceTier };
    });
  };
}

function createGuardrailWrapStreamFn(
  innerWrapStreamFn: (ctx: {
    modelId: string;
    model?: { params?: Record<string, unknown> };
    streamFn?: StreamFn;
  }) => StreamFn | null | undefined,
  guardrailConfig: GuardrailConfig,
): (ctx: {
  modelId: string;
  model?: { params?: Record<string, unknown> };
  streamFn?: StreamFn;
}) => StreamFn | null | undefined {
  return (ctx) => {
    const inner = innerWrapStreamFn(ctx);
    if (!inner) {
      return inner;
    }
    return (model, context, options) => {
      return streamWithPayloadPatch(inner, model, context, options, (payload) => {
        const gc: Record<string, unknown> = {
          guardrailIdentifier: guardrailConfig.guardrailIdentifier,
          guardrailVersion: guardrailConfig.guardrailVersion,
        };
        if (guardrailConfig.streamProcessingMode) {
          gc.streamProcessingMode = guardrailConfig.streamProcessingMode;
        }
        if (guardrailConfig.trace) {
          gc.trace = guardrailConfig.trace;
        }
        payload.guardrailConfig = gc;
      });
    };
  };
}

function sharedRuntimeWouldInjectCachePoints(modelId: string): boolean {
  return supportsBedrockPromptCaching(modelId);
}

/**
 * Detect Bedrock application inference profile ARNs — these are the only IDs
 * where model-name-based checks fail because the ARN is opaque.
 * System-defined profiles (us., eu., global.) and base model IDs always
 * contain the model name and are handled by the shared model runtime natively.
 */
const BEDROCK_APP_INFERENCE_PROFILE_RE =
  /^arn:aws(-cn|-us-gov)?:bedrock:.*:application-inference-profile\//i;

function isBedrockAppInferenceProfile(modelId: string): boolean {
  return BEDROCK_APP_INFERENCE_PROFILE_RE.test(modelId);
}

/**
 * The shared runtime's `supportsPromptCaching` checks `model.id` for specific Claude
 * model name patterns, which fails for application inference profile ARNs (opaque
 * IDs that may not contain the model name). When OpenClaw's `isAnthropicBedrockModel`
 * identifies the model but the shared runtime won't inject cache points, we do it via onPayload.
 *
 * Gated to application inference profile ARNs only — regular Claude model IDs and
 * system-defined inference profiles (us.anthropic.claude-*) are left to the shared runtime.
 */
function needsCachePointInjection(modelId: string): boolean {
  // Only target application inference profile ARNs.
  if (!isBedrockAppInferenceProfile(modelId)) {
    return false;
  }
  // If the shared runtime would already inject cache points, skip.
  if (sharedRuntimeWouldInjectCachePoints(modelId)) {
    return false;
  }
  // Check if OpenClaw identifies this as an Anthropic model via the ARN heuristic.
  if (isAnthropicBedrockModel(modelId)) {
    return true;
  }
  return false;
}

/**
 * Extract the region from a Bedrock ARN.
 * e.g. "arn:aws:bedrock:us-east-1:123:application-inference-profile/abc" → "us-east-1"
 */
function extractRegionFromArn(arn: string): string | undefined {
  const parts = arn.split(":");
  // ARN format: arn:partition:service:region:account:resource
  return parts.length >= 4 && parts[3] ? parts[3] : undefined;
}

/**
 * Check if a resolved foundation model ARN supports prompt caching using the
 * same matcher OpenClaw uses for direct model IDs.
 */
function resolvedModelSupportsCaching(modelArn: string): boolean {
  return supportsBedrockPromptCaching(modelArn);
}

/**
 * Resolve the underlying foundation model for an application inference profile
 * via GetInferenceProfile. Results are cached so we only call the API once per
 * profile ARN. Returns traits needed for request shaping when the model id is
 * otherwise opaque.
 *
 * Region is extracted from the profile ARN itself to avoid mismatches when
 * the OpenClaw config region differs from the profile's home region.
 */
type BedrockAppProfileTraits = {
  cacheEligible: boolean;
  omitTemperature: boolean;
};

const appProfileTraitsCache = new Map<string, BedrockAppProfileTraits>();

type BedrockGetInferenceProfileResponse = {
  models?: Array<{ modelArn?: string }>;
};

type BedrockControlPlane = {
  getInferenceProfile: (input: {
    inferenceProfileIdentifier: string;
  }) => Promise<BedrockGetInferenceProfileResponse>;
};

async function createBedrockControlPlane(region: string | undefined): Promise<BedrockControlPlane> {
  await refreshAwsSharedConfigCacheForBedrock();
  const { BedrockClient, GetInferenceProfileCommand } = await import("@aws-sdk/client-bedrock");
  const client = new BedrockClient(region ? { region } : {});
  return {
    getInferenceProfile: async (input) => await client.send(new GetInferenceProfileCommand(input)),
  };
}

async function resolveAppProfileTraits(
  modelId: string,
  fallbackRegion: string | undefined,
): Promise<BedrockAppProfileTraits> {
  const cached = appProfileTraitsCache.get(modelId);
  if (cached) {
    return cached;
  }
  try {
    const region = extractRegionFromArn(modelId) ?? fallbackRegion;
    const controlPlane = await createBedrockControlPlane(region);
    const resp = await controlPlane.getInferenceProfile({ inferenceProfileIdentifier: modelId });
    const models = resp.models ?? [];
    const modelArns = models.map((m: { modelArn?: string }) => m.modelArn ?? "");
    const traits = {
      cacheEligible:
        models.length > 0 && modelArns.every((modelArn) => resolvedModelSupportsCaching(modelArn)),
      omitTemperature: modelArns.some(isOpus47OrNewerBedrockModelRef),
    };
    appProfileTraitsCache.set(modelId, traits);
    return traits;
  } catch {
    // Transient failures (throttling, network, IAM) should not be cached —
    // return the heuristic fallback but allow retry on the next request.
    return {
      cacheEligible: isAnthropicBedrockModel(modelId),
      omitTemperature: isOpus47OrNewerBedrockModelRef(modelId),
    };
  }
}

type BedrockCachePoint = { cachePoint: { type: "default"; ttl?: string } };
type BedrockContentBlock = Record<string, unknown>;
type BedrockMessage = { role?: string; content?: BedrockContentBlock[] };

function hasCachePoint(blocks: BedrockContentBlock[] | undefined): boolean {
  return blocks?.some((b) => b.cachePoint != null) === true;
}

function makeCachePoint(cacheRetention: string | undefined): BedrockCachePoint {
  return {
    cachePoint: {
      type: "default",
      ...(cacheRetention === "long" ? { ttl: "1h" } : {}),
    },
  };
}

/**
 * Inject Bedrock Converse cache points into the payload when the shared runtime skipped them
 * because it didn't recognize the model ID (application inference profiles).
 */
function injectBedrockCachePoints(
  payload: Record<string, unknown>,
  cacheRetention: string | undefined,
): void {
  if (!cacheRetention || cacheRetention === "none") {
    return;
  }
  const point = makeCachePoint(cacheRetention);

  // Inject into system prompt if missing.
  const system = payload.system as BedrockContentBlock[] | undefined;
  if (Array.isArray(system) && system.length > 0 && !hasCachePoint(system)) {
    system.push(point);
  }

  // Inject into the last user message if missing.
  // Bedrock Converse uses lowercase roles ("user" / "assistant").
  const messages = payload.messages as BedrockMessage[] | undefined;
  if (Array.isArray(messages) && messages.length > 0) {
    for (const msg of messages.toReversed()) {
      if (msg.role === "user" && Array.isArray(msg.content)) {
        if (!hasCachePoint(msg.content)) {
          msg.content.push(point);
        }
        break;
      }
    }
  }
}

function patchMaxThinkingEffort(payload: Record<string, unknown>): void {
  const fieldsValue = payload.additionalModelRequestFields;
  const fields =
    fieldsValue && typeof fieldsValue === "object" && !Array.isArray(fieldsValue)
      ? (fieldsValue as Record<string, unknown>)
      : {};
  const outputConfigValue = fields.output_config;
  const outputConfig =
    outputConfigValue && typeof outputConfigValue === "object" && !Array.isArray(outputConfigValue)
      ? (outputConfigValue as Record<string, unknown>)
      : {};
  outputConfig.effort = "max";
  fields.output_config = outputConfig;
  payload.additionalModelRequestFields = fields;
}

/** Register Amazon Bedrock provider, discovery catalog, stream wrappers, and embeddings. */
export function registerAmazonBedrockPlugin(api: OpenClawPluginApi): void {
  // Keep registration-local constants inside the function so partial module
  // initialization during test bootstrap cannot trip TDZ reads.
  const providerId = "amazon-bedrock";
  // Match region from bedrock-runtime (Converse API) URLs.
  // e.g. https://bedrock-runtime.us-east-1.amazonaws.com
  const bedrockRegionRe = /bedrock-runtime\.([a-z0-9-]+)\.amazonaws\./;
  const bedrockContextOverflowPatterns = [
    /ValidationException.*(?:input is too long|max input token|input token.*exceed)/i,
    /ValidationException.*(?:exceeds? the (?:maximum|max) (?:number of )?(?:input )?tokens)/i,
    /ModelStreamErrorException.*(?:Input is too long|too many input tokens)/i,
  ] as const;
  const deprecatedTemperatureValidationRe =
    /ValidationException[\s\S]*(?:invalid_request_error[\s\S]*)?temperature[\s\S]*deprecated|ValidationException[\s\S]*deprecated[\s\S]*temperature/i;
  const anthropicByModelReplayHooks = ANTHROPIC_BY_MODEL_REPLAY_HOOKS;
  const startupPluginConfig = (api.pluginConfig ?? {}) as AmazonBedrockPluginConfig;

  registerApiProvider(
    {
      api: "bedrock-converse-stream",
      stream: streamBedrock,
      streamSimple: streamSimpleBedrock,
    },
    `plugin:${providerId}`,
  );

  function resolveCurrentPluginConfig(
    config: OpenClawConfig | undefined,
  ): AmazonBedrockPluginConfig | undefined {
    const runtimePluginConfig = resolvePluginConfigObject(config, providerId);
    return (
      (runtimePluginConfig as AmazonBedrockPluginConfig | undefined) ??
      (config ? undefined : startupPluginConfig)
    );
  }

  api.registerMemoryEmbeddingProvider(bedrockMemoryEmbeddingProviderAdapter);

  const baseWrapStreamFn = ({
    modelId,
    model,
    streamFn,
  }: {
    modelId: string;
    model?: { params?: Record<string, unknown> };
    streamFn?: StreamFn;
  }) => {
    const modelRef = { id: modelId, params: model?.params };
    if (
      isAnthropicBedrockModel(modelId) ||
      resolveClaudeModelIdentity(modelRef).startsWith("claude-")
    ) {
      return streamFn;
    }
    // For app inference profiles with opaque IDs, don't force cacheRetention: "none"
    // yet — we may resolve them as Claude later via GetInferenceProfile.
    if (isBedrockAppInferenceProfile(modelId)) {
      return streamFn;
    }
    return createBedrockNoCacheWrapper(streamFn);
  };

  function omitUnsupportedClaudeTemperature<TOptions extends object>(
    modelRef: { id: string; params?: Record<string, unknown> },
    options: TOptions,
  ): TOptions {
    const canonicalModelId = resolveClaudeModelIdentity(modelRef);
    const omitsTemperature =
      isOpus47OrNewerBedrockModelRef(modelRef.id) ||
      isOpus47OrNewerBedrockModelRef(canonicalModelId) ||
      resolveClaudeFable5ModelIdentity(modelRef) !== undefined;
    if (!omitsTemperature || !("temperature" in options)) {
      return options;
    }
    const next = { ...options } as typeof options & { temperature?: unknown };
    delete next.temperature;
    return next;
  }

  function omitUnsupportedClaudePayloadTemperature(payload: Record<string, unknown>): void {
    const inferenceConfig = payload.inferenceConfig;
    if (!inferenceConfig || typeof inferenceConfig !== "object") {
      return;
    }
    delete (inferenceConfig as Record<string, unknown>).temperature;
  }

  function withAwsCredentialRefreshOnPayload<TOptions extends object>(
    options: TOptions,
  ): TOptions & { onPayload: (payload: unknown, payloadModel: unknown) => Promise<unknown> } {
    const originalOnPayload = (options as { onPayload?: unknown }).onPayload as
      | ((payload: unknown, model: unknown) => unknown)
      | undefined;
    return {
      ...options,
      onPayload: async (payload: unknown, payloadModel: unknown) => {
        await refreshAwsSharedConfigCacheForBedrock();
        return originalOnPayload?.(payload, payloadModel);
      },
    };
  }

  function createAwsCredentialRefreshStreamWrapper(
    streamFn: StreamFn | null | undefined,
  ): StreamFn | null | undefined {
    if (!streamFn) {
      return streamFn;
    }
    return (streamModel, context, options) =>
      streamFn(streamModel, context, withAwsCredentialRefreshOnPayload(Object.assign({}, options)));
  }

  /** Extract the AWS region from a bedrock-runtime baseUrl. */
  function extractRegionFromBaseUrl(baseUrl: string | undefined): string | undefined {
    if (!baseUrl) {
      return undefined;
    }
    return bedrockRegionRe.exec(baseUrl)?.[1];
  }

  /** Resolve the AWS region for Bedrock API calls from provider-specific baseUrl. */
  function resolveBedrockRegion(
    config: { models?: { providers?: Record<string, unknown> } } | undefined,
  ): string | undefined {
    // Try provider-specific baseUrl first.
    const providers = config?.models?.providers;
    if (providers) {
      const exact = (providers[providerId] as { baseUrl?: string } | undefined)?.baseUrl;
      if (exact) {
        const region = extractRegionFromBaseUrl(exact);
        if (region) {
          return region;
        }
      }
      // Fall back to alias matches (e.g. "bedrock" instead of "amazon-bedrock").
      for (const [key, value] of Object.entries(providers)) {
        if (key === providerId || normalizeProviderId(key) !== providerId) {
          continue;
        }
        const region = extractRegionFromBaseUrl((value as { baseUrl?: string }).baseUrl);
        if (region) {
          return region;
        }
      }
    }
    return undefined;
  }

  api.registerProvider({
    id: providerId,
    label: "Amazon Bedrock",
    docsPath: "/providers/models",
    auth: [],
    catalog: {
      order: "simple",
      run: async (ctx) => {
        const { resolveImplicitBedrockProvider } = await import("./discovery.js");
        const currentPluginConfig = resolveCurrentPluginConfig(ctx.config);
        const implicit = await resolveImplicitBedrockProvider({
          pluginConfig: currentPluginConfig,
          env: ctx.env,
        });
        if (!implicit) {
          return null;
        }
        return {
          provider: mergeImplicitBedrockProvider({
            existing: ctx.config.models?.providers?.[providerId],
            implicit,
          }),
        };
      },
    },
    resolveConfigApiKey: ({ env }) => resolveBedrockConfigApiKey(env),
    normalizeResolvedModel: normalizeBedrockResolvedModel,
    ...anthropicByModelReplayHooks,
    wrapStreamFn: ({ modelId, config, model, streamFn, thinkingLevel, extraParams }) => {
      const currentPluginConfig = resolveCurrentPluginConfig(config);
      const currentGuardrail = currentPluginConfig?.guardrail;
      const modelRef = { id: modelId, params: model?.params };
      const fable5 = resolveClaudeFable5ModelIdentity(modelRef) !== undefined;
      const sonnet5 = resolveClaudeSonnet5ModelIdentity(modelRef) !== undefined;
      const canonicalModelId = resolveClaudeModelIdentity(modelRef);
      const opus47OrNewer =
        isOpus47OrNewerBedrockModelRef(modelId) || isOpus47OrNewerBedrockModelRef(canonicalModelId);
      const supportsNativeMax = supportsBedrockNativeMaxEffort(modelId, model?.params);
      let wrapped =
        (currentGuardrail?.guardrailIdentifier && currentGuardrail?.guardrailVersion
          ? createGuardrailWrapStreamFn(
              baseWrapStreamFn,
              currentGuardrail,
            )({
              modelId,
              model,
              streamFn,
            })
          : baseWrapStreamFn({ modelId, model, streamFn })) ?? undefined;

      const serviceTier = resolveBedrockServiceTier(extraParams, (message) =>
        api.logger.warn(message),
      );
      if (serviceTier && wrapped) {
        if ((fable5 || sonnet5) && serviceTier !== "default") {
          const modelLabel = fable5 ? "Fable 5" : "Sonnet 5";
          api.logger.warn(
            `ignoring unsupported ${modelLabel} Bedrock service tier: ${serviceTier}`,
          );
        } else {
          wrapped = createBedrockServiceTierWrapper(wrapped, serviceTier);
        }
      }

      const region =
        resolveBedrockRegion(config) ??
        extractRegionFromBaseUrl(model?.baseUrl) ??
        currentPluginConfig?.discovery?.region;
      const mayNeedCacheInjection =
        isBedrockAppInferenceProfile(modelId) && !sharedRuntimeWouldInjectCachePoints(modelId);
      const shouldOmitTemperature =
        opus47OrNewer || fable5 || isLatestAdaptiveBedrockModelRef(modelId, model?.params);
      const shouldPatchMaxThinking = supportsNativeMax && thinkingLevel === "max";
      const shouldPatchPayload = shouldOmitTemperature || shouldPatchMaxThinking;

      // For known Anthropic models (heuristic match), enable injection immediately.
      // For opaque profile IDs, we'll resolve via GetInferenceProfile on first call.
      const heuristicMatch = needsCachePointInjection(modelId);

      if (!region && !mayNeedCacheInjection && !shouldOmitTemperature && !shouldPatchMaxThinking) {
        return createAwsCredentialRefreshStreamWrapper(wrapped);
      }

      const underlying = wrapped ?? streamFn;
      if (!underlying) {
        return wrapped;
      }
      return (streamModel, context, options) => {
        const merged = omitUnsupportedClaudeTemperature(
          modelRef,
          Object.assign({}, options, region ? { region } : {}),
        );

        const originalOnPayload = merged.onPayload as
          | ((payload: unknown, model: unknown) => unknown)
          | undefined;

        if (!mayNeedCacheInjection) {
          return underlying(
            streamModel,
            context,
            withAwsCredentialRefreshOnPayload({
              ...merged,
              ...(shouldPatchPayload
                ? {
                    onPayload: (payload: unknown, payloadModel: unknown) => {
                      if (payload && typeof payload === "object") {
                        const payloadRecord = payload as Record<string, unknown>;
                        if (shouldPatchMaxThinking) {
                          patchMaxThinkingEffort(payloadRecord);
                        }
                        if (shouldOmitTemperature) {
                          omitUnsupportedClaudePayloadTemperature(payloadRecord);
                        }
                      }
                      return originalOnPayload?.(payload, payloadModel);
                    },
                  }
                : {}),
            }),
          );
        }

        // Use the cacheRetention from options if explicitly set.
        // When undefined, default to "short" to match the shared runtime default.
        // Note: if the user set cacheRetention: "none" but the opaque ARN wasn't
        // recognized by resolveAnthropicCacheRetentionFamily, the value may have
        // been dropped upstream. This is a known limitation — the proper fix is
        // to also teach resolveAnthropicCacheRetentionFamily about opaque profiles
        // (tracked separately). In practice, users with app inference profiles
        // want caching enabled, so defaulting to "short" is the safer behavior.
        const cacheRetention =
          typeof merged.cacheRetention === "string" ? merged.cacheRetention : "short";
        if (heuristicMatch) {
          // Fast path: ARN heuristic already identified this as Claude, but the
          // concrete target may still need profile traits for Opus 4.7 payloads.
          const mayNeedTemperatureTrait = "temperature" in merged;
          return underlying(
            streamModel,
            context,
            withAwsCredentialRefreshOnPayload({
              ...merged,
              onPayload: async (payload: unknown, payloadModel: unknown) => {
                if (payload && typeof payload === "object") {
                  const payloadRecord = payload as Record<string, unknown>;
                  injectBedrockCachePoints(payloadRecord, cacheRetention);
                  if (shouldPatchMaxThinking) {
                    patchMaxThinkingEffort(payloadRecord);
                  }
                  if (shouldOmitTemperature) {
                    omitUnsupportedClaudePayloadTemperature(payloadRecord);
                  } else if (mayNeedTemperatureTrait) {
                    const traits = await resolveAppProfileTraits(modelId, region);
                    if (traits.omitTemperature) {
                      omitUnsupportedClaudePayloadTemperature(payloadRecord);
                    }
                  }
                }
                return originalOnPayload?.(payload, payloadModel);
              },
            }),
          );
        }

        // Slow path: opaque profile ID — resolve underlying model via API (cached).
        // onPayload supports async, so we await the resolution inline.
        return underlying(
          streamModel,
          context,
          withAwsCredentialRefreshOnPayload({
            ...merged,
            onPayload: async (payload: unknown, payloadModel: unknown) => {
              const traits = await resolveAppProfileTraits(modelId, region);
              if (payload && typeof payload === "object") {
                const payloadRecord = payload as Record<string, unknown>;
                if (traits.cacheEligible) {
                  injectBedrockCachePoints(payloadRecord, cacheRetention);
                }
                if (shouldPatchMaxThinking) {
                  patchMaxThinkingEffort(payloadRecord);
                }
                if (traits.omitTemperature) {
                  omitUnsupportedClaudePayloadTemperature(payloadRecord);
                }
              }
              return originalOnPayload?.(payload, payloadModel);
            },
          }),
        );
      };
    },
    matchesContextOverflowError: ({ errorMessage }) =>
      bedrockContextOverflowPatterns.some((pattern) => pattern.test(errorMessage)),
    classifyFailoverReason: ({ errorMessage }) => {
      if (/ThrottlingException|Too many concurrent requests/i.test(errorMessage)) {
        return "rate_limit";
      }
      if (/ModelNotReadyException/i.test(errorMessage)) {
        return "overloaded";
      }
      if (deprecatedTemperatureValidationRe.test(errorMessage)) {
        return "format";
      }
      return undefined;
    },
    resolveThinkingProfile: ({ modelId, params }) =>
      resolveBedrockClaudeThinkingProfile(modelId, params),
  });
}
