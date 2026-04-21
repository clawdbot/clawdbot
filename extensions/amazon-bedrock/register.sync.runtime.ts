import type { StreamFn } from "@mariozechner/pi-agent-core";
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
  const pluginConfig = (api.pluginConfig ?? {}) as AmazonBedrockPluginConfig;
  const guardrail = pluginConfig.guardrail;

  api.registerMemoryEmbeddingProvider(bedrockMemoryEmbeddingProviderAdapter);

  const baseWrapStreamFn = ({ modelId, streamFn }: { modelId: string; streamFn?: StreamFn }) =>
    isAnthropicBedrockModel(modelId) ? streamFn : createBedrockNoCacheWrapper(streamFn);

  const cacheWrapStreamFn =
    guardrail?.guardrailIdentifier && guardrail?.guardrailVersion
      ? createGuardrailWrapStreamFn(baseWrapStreamFn, guardrail)
      : baseWrapStreamFn;

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
        const implicit = await resolveImplicitBedrockProvider({
          config: ctx.config,
          pluginConfig,
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
      // Apply cache + guardrail wrapping.
      const wrapped = cacheWrapStreamFn({ modelId, streamFn });
      const region = resolveBedrockRegion(config) ?? extractRegionFromBaseUrl(model?.baseUrl);

      if (!region) {
        return wrapped;
      }

      // Wrap to inject the region into every stream call so pi-ai's Bedrock
      // client connects to the right region for inference profile IDs.
      const underlying = wrapped ?? streamFn;
      if (!underlying) {
        return wrapped;
      }
      return (streamModel, context, options) => {
        // pi-ai's bedrock provider reads `options.region` at runtime but the
        // StreamFn type does not declare it. Merge via Object.assign to avoid
        // an unsafe type assertion.
        const merged = Object.assign({}, options, { region });
        return underlying(streamModel, context, merged);
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
