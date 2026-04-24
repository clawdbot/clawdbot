import type { StreamFn } from "@mariozechner/pi-agent-core";
import { resolvePluginConfigObject, type OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  ANTHROPIC_BY_MODEL_REPLAY_HOOKS,
  normalizeProviderId,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  createBedrockNoCacheWrapper,
  isAnthropicBedrockModel,
  streamWithPayloadPatch,
} from "openclaw/plugin-sdk/provider-stream-shared";
import {
  mergeImplicitBedrockProvider,
  resolveBedrockConfigApiKey,
  resolveImplicitBedrockProvider,
} from "./api.js";
import { bedrockMemoryEmbeddingProviderAdapter } from "./memory-embedding-adapter.js";

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

function createGuardrailWrapStreamFn(
  innerWrapStreamFn: (ctx: { modelId: string; streamFn?: StreamFn }) => StreamFn | null | undefined,
  guardrailConfig: GuardrailConfig,
): (ctx: { modelId: string; streamFn?: StreamFn }) => StreamFn | null | undefined {
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

/**
 * Mirrors the shipped pi-ai Bedrock `supportsPromptCaching` matcher.
 * Keep this in sync with node_modules/@mariozechner/pi-ai/dist/providers/amazon-bedrock.js.
 */
function matchesPiAiPromptCachingModelId(modelId: string): boolean {
  const id = modelId.toLowerCase();
  if (!id.includes("claude")) {
    return false;
  }
  // Claude 4.x
  if (id.includes("-4-") || id.includes("-4.")) {
    return true;
  }
  // Claude 3.7 Sonnet
  if (id.includes("claude-3-7-sonnet")) {
    return true;
  }
  // Claude 3.5 Haiku
  if (id.includes("claude-3-5-haiku")) {
    return true;
  }
  return false;
}

function piAiWouldInjectCachePoints(modelId: string): boolean {
  return matchesPiAiPromptCachingModelId(modelId);
}

/**
 * Detect Bedrock application inference profile ARNs — these are the only IDs
 * where pi-ai's model-name-based checks fail because the ARN is opaque.
 * System-defined profiles (us., eu., global.) and base model IDs always
 * contain the model name and are handled by pi-ai natively.
 */
const BEDROCK_APP_INFERENCE_PROFILE_RE =
  /^arn:aws(-cn|-us-gov)?:bedrock:.*:application-inference-profile\//i;

function isBedrockAppInferenceProfile(modelId: string): boolean {
  return BEDROCK_APP_INFERENCE_PROFILE_RE.test(modelId);
}

/**
 * pi-ai's internal `supportsPromptCaching` checks `model.id` for specific Claude
 * model name patterns, which fails for application inference profile ARNs (opaque
 * IDs that may not contain the model name). When OpenClaw's `isAnthropicBedrockModel`
 * identifies the model but pi-ai won't inject cache points, we do it via onPayload.
 *
 * Gated to application inference profile ARNs only — regular Claude model IDs and
 * system-defined inference profiles (us.anthropic.claude-*) are left to pi-ai.
 */
function needsCachePointInjection(modelId: string): boolean {
  // Only target application inference profile ARNs.
  if (!isBedrockAppInferenceProfile(modelId)) {
    return false;
  }
  // If pi-ai would already inject cache points, skip.
  if (piAiWouldInjectCachePoints(modelId)) {
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
 * same matcher pi-ai uses for direct model IDs.
 */
function resolvedModelSupportsCaching(modelArn: string): boolean {
  return matchesPiAiPromptCachingModelId(modelArn);
}

/**
 * Resolve the underlying foundation model for an application inference profile
 * via GetInferenceProfile. Results are cached so we only call the API once per
 * profile ARN. Returns true if the underlying model supports prompt caching.
 *
 * Region is extracted from the profile ARN itself to avoid mismatches when
 * the OpenClaw config region differs from the profile's home region.
 */
const appProfileCacheEligibleCache = new Map<string, boolean>();

export function resetBedrockAppProfileCacheEligibilityForTest(): void {
  appProfileCacheEligibleCache.clear();
}

async function resolveAppProfileCacheEligible(
  modelId: string,
  fallbackRegion: string | undefined,
): Promise<boolean> {
  if (appProfileCacheEligibleCache.has(modelId)) {
    return appProfileCacheEligibleCache.get(modelId)!;
  }
  try {
    const { BedrockClient, GetInferenceProfileCommand } = await import("@aws-sdk/client-bedrock");
    const region = extractRegionFromArn(modelId) ?? fallbackRegion;
    const client = new BedrockClient(region ? { region } : {});
    const resp = await client.send(
      new GetInferenceProfileCommand({ inferenceProfileIdentifier: modelId }),
    );
    const models = resp.models ?? [];
    const eligible =
      models.length > 0 &&
      models.every((m: { modelArn?: string }) => resolvedModelSupportsCaching(m.modelArn ?? ""));
    appProfileCacheEligibleCache.set(modelId, eligible);
    return eligible;
  } catch {
    // Transient failures (throttling, network, IAM) should not be cached —
    // return the heuristic fallback but allow retry on the next request.
    return isAnthropicBedrockModel(modelId);
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
 * Inject Bedrock Converse cache points into the payload when pi-ai skipped them
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
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "user" && Array.isArray(msg.content)) {
        if (!hasCachePoint(msg.content)) {
          msg.content.push(point);
        }
        break;
      }
    }
  }
}

export function registerAmazonBedrockPlugin(api: OpenClawPluginApi): void {
  // Keep registration-local constants inside the function so partial module
  // initialization during test bootstrap cannot trip TDZ reads.
  const providerId = "amazon-bedrock";
  const claude46ModelRe = /claude-(?:opus|sonnet)-4(?:\.|-)6(?:$|[-.])/i;
  // Match region from bedrock-runtime (Converse API) URLs.
  // e.g. https://bedrock-runtime.us-east-1.amazonaws.com
  const bedrockRegionRe = /bedrock-runtime\.([a-z0-9-]+)\.amazonaws\./;
  const bedrockContextOverflowPatterns = [
    /ValidationException.*(?:input is too long|max input token|input token.*exceed)/i,
    /ValidationException.*(?:exceeds? the (?:maximum|max) (?:number of )?(?:input )?tokens)/i,
    /ModelStreamErrorException.*(?:Input is too long|too many input tokens)/i,
  ] as const;
  const anthropicByModelReplayHooks = ANTHROPIC_BY_MODEL_REPLAY_HOOKS;
  const startupPluginConfig = (api.pluginConfig ?? {}) as AmazonBedrockPluginConfig;

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

  const baseWrapStreamFn = ({ modelId, streamFn }: { modelId: string; streamFn?: StreamFn }) => {
    if (isAnthropicBedrockModel(modelId)) {
      return streamFn;
    }
    // For app inference profiles with opaque IDs, don't force cacheRetention: "none"
    // yet — we may resolve them as Claude later via GetInferenceProfile.
    if (isBedrockAppInferenceProfile(modelId)) {
      return streamFn;
    }
    return createBedrockNoCacheWrapper(streamFn);
  };

  /** Extract the AWS region from a bedrock-runtime baseUrl. */
  function extractRegionFromBaseUrl(baseUrl: string | undefined): string | undefined {
    if (!baseUrl) {
      return undefined;
    }
    return bedrockRegionRe.exec(baseUrl)?.[1];
  }

  /**
   * Resolve the AWS region for Bedrock API calls.
   * Provider-specific baseUrl wins over global bedrockDiscovery to avoid signing
   * with the wrong region when discovery and provider target different regions.
   */
  function resolveBedrockRegion(
    config:
      | { models?: { bedrockDiscovery?: { region?: string }; providers?: Record<string, unknown> } }
      | undefined,
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
    return config?.models?.bedrockDiscovery?.region;
  }

  api.registerProvider({
    id: providerId,
    label: "Amazon Bedrock",
    docsPath: "/providers/models",
    auth: [],
    catalog: {
      order: "simple",
      run: async (ctx) => {
        const currentPluginConfig = resolveCurrentPluginConfig(ctx.config);
        const implicit = await resolveImplicitBedrockProvider({
          config: ctx.config,
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
    ...anthropicByModelReplayHooks,
    wrapStreamFn: ({ modelId, config, model, streamFn }) => {
      const currentGuardrail = resolveCurrentPluginConfig(config)?.guardrail;
      // Apply cache + guardrail wrapping.
      const wrapped =
        currentGuardrail?.guardrailIdentifier && currentGuardrail?.guardrailVersion
          ? createGuardrailWrapStreamFn(baseWrapStreamFn, currentGuardrail)({ modelId, streamFn })
          : baseWrapStreamFn({ modelId, streamFn });
      const region = resolveBedrockRegion(config) ?? extractRegionFromBaseUrl(model?.baseUrl);
      const mayNeedCacheInjection =
        isBedrockAppInferenceProfile(modelId) && !piAiWouldInjectCachePoints(modelId);

      // For known Anthropic models (heuristic match), enable injection immediately.
      // For opaque profile IDs, we'll resolve via GetInferenceProfile on first call.
      const heuristicMatch = needsCachePointInjection(modelId);

      if (!region && !mayNeedCacheInjection) {
        return wrapped;
      }

      const underlying = wrapped ?? streamFn;
      if (!underlying) {
        return wrapped;
      }
      return (streamModel, context, options) => {
        const merged = Object.assign({}, options, region ? { region } : {});

        if (!mayNeedCacheInjection) {
          return underlying(streamModel, context, merged);
        }

        // Use the cacheRetention from options if explicitly set.
        // When undefined, default to "short" to match pi-ai's internal default.
        // Note: if the user set cacheRetention: "none" but the opaque ARN wasn't
        // recognized by resolveAnthropicCacheRetentionFamily, the value may have
        // been dropped upstream. This is a known limitation — the proper fix is
        // to also teach resolveAnthropicCacheRetentionFamily about opaque profiles
        // (tracked separately). In practice, users with app inference profiles
        // want caching enabled, so defaulting to "short" is the safer behavior.
        const cacheRetention =
          typeof merged.cacheRetention === "string" ? merged.cacheRetention : "short";

        if (heuristicMatch) {
          // Fast path: ARN heuristic already identified this as Claude.
          return streamWithPayloadPatch(underlying, streamModel, context, merged, (payload) => {
            injectBedrockCachePoints(payload, cacheRetention);
          });
        }

        // Slow path: opaque profile ID — resolve underlying model via API (cached).
        // pi-ai's onPayload supports async, so we await the resolution inline.
        const originalOnPayload = merged.onPayload as
          | ((payload: unknown, model: unknown) => unknown)
          | undefined;
        return underlying(streamModel, context, {
          ...merged,
          onPayload: async (payload: unknown, payloadModel: unknown) => {
            const eligible = await resolveAppProfileCacheEligible(modelId, region);
            if (eligible && payload && typeof payload === "object") {
              injectBedrockCachePoints(payload as Record<string, unknown>, cacheRetention);
            }
            return originalOnPayload?.(payload, payloadModel);
          },
        });
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
      return undefined;
    },
    resolveThinkingProfile: ({ modelId }) => ({
      levels: [
        { id: "off" },
        { id: "minimal" },
        { id: "low" },
        { id: "medium" },
        { id: "high" },
        ...(claude46ModelRe.test(modelId.trim()) ? [{ id: "adaptive" as const }] : []),
      ],
      defaultLevel: claude46ModelRe.test(modelId.trim()) ? "adaptive" : undefined,
    }),
  });
}
