// Zai plugin entrypoint registers its OpenClaw integration.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  definePluginEntry,
  type ProviderAuthContext,
  type ProviderAuthMethod,
  type ProviderAuthMethodNonInteractiveContext,
  type ProviderResolveDynamicModelContext,
  type ProviderRuntimeModel,
  type ProviderWrapStreamFnContext,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  applyAuthProfileConfig,
  buildApiKeyCredential,
  ensureApiKeyFromOptionEnvOrPrompt,
  normalizeApiKeyInput,
  normalizeOptionalSecretInput,
  type SecretInput,
  upsertAuthProfileWithLock,
  validateApiKeyInput,
} from "openclaw/plugin-sdk/provider-auth-api-key";
import { buildOpenAICompatibleProviderCatalog } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import {
  buildProviderReplayFamilyHooks,
  normalizeModelCompat,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  createPayloadPatchStreamWrapper,
  createToolStreamWrapper,
  defaultToolStreamExtraParams,
} from "openclaw/plugin-sdk/provider-stream-shared";
import { fetchZaiUsage } from "openclaw/plugin-sdk/provider-usage";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { detectZaiEndpoint, type ZaiEndpointId } from "./detect.js";
import { zaiMediaUnderstandingProvider } from "./media-understanding-provider.js";
import { buildZaiModelDefinition, resolveZaiBaseUrl } from "./model-definitions.js";
import { applyZaiConfig, applyZaiProviderConfig, resolveZaiModelId } from "./onboard.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { isGlm52ModelId, resolveThinkingProfile } from "./provider-policy-api.js";

const PROVIDER_ID = "zai";
const GLM5_TEMPLATE_MODEL_ID = "glm-4.7";
const PROFILE_ID = "zai:default";
type UpsertAuthProfileParams = Parameters<typeof upsertAuthProfileWithLock>[0];

function buildZaiCatalogProvider() {
  return buildManifestModelProviderConfig({
    providerId: PROVIDER_ID,
    catalog: manifest.modelCatalog.providers.zai,
  });
}

function resolveDeprecatedPiAgentAuthPath(env: NodeJS.ProcessEnv): string {
  const home = env.HOME?.trim() || env.USERPROFILE?.trim() || os.homedir();
  return path.join(home, ".pi", "agent", "auth.json");
}

function resolveDeprecatedPiAgentAccessToken(
  env: NodeJS.ProcessEnv,
  providerIds: readonly string[],
): string | undefined {
  try {
    const authPath = resolveDeprecatedPiAgentAuthPath(env);
    if (!fs.existsSync(authPath)) {
      return undefined;
    }
    const parsed = JSON.parse(fs.readFileSync(authPath, "utf-8")) as Record<
      string,
      { access?: unknown }
    >;
    for (const providerId of providerIds) {
      const token = parsed[providerId]?.access;
      if (typeof token === "string" && token.trim()) {
        return token;
      }
    }
  } catch {}
  return undefined;
}

async function upsertAuthProfileWithLockOrThrow(params: UpsertAuthProfileParams): Promise<void> {
  const updated = await upsertAuthProfileWithLock(params);
  if (!updated) {
    throw new Error(
      "Failed to update auth profile store; the auth store lock may be busy. Wait a moment and retry.",
    );
  }
}

function resolveGlm5ForwardCompatModel(
  ctx: ProviderResolveDynamicModelContext,
): ProviderRuntimeModel | undefined {
  const trimmedModelId = ctx.modelId.trim();
  if (!normalizeLowercaseStringOrEmpty(trimmedModelId).startsWith("glm-5")) {
    return undefined;
  }

  const existing = ctx.modelRegistry.find(
    PROVIDER_ID,
    trimmedModelId,
  ) as ProviderRuntimeModel | null;
  if (existing) {
    return existing;
  }

  const def = buildZaiModelDefinition({ id: trimmedModelId });
  const template = ctx.modelRegistry.find(
    PROVIDER_ID,
    GLM5_TEMPLATE_MODEL_ID,
  ) as ProviderRuntimeModel | null;
  return normalizeModelCompat({
    ...template,
    id: def.id,
    name: def.name,
    // Native models must never fall through to the OpenAI SDK's default host.
    baseUrl: ctx.providerConfig?.baseUrl ?? template?.baseUrl ?? resolveZaiBaseUrl(),
    api: "openai-completions",
    provider: PROVIDER_ID,
    reasoning: def.reasoning,
    input: def.input,
    cost: def.cost,
    contextWindow: def.contextWindow,
    maxTokens: def.maxTokens,
  } as ProviderRuntimeModel);
}

function isTrueParam(value: unknown): boolean {
  return value === true;
}

function shouldPreserveZaiThinking(extraParams?: Record<string, unknown>): boolean {
  return isTrueParam(extraParams?.preserveThinking) || isTrueParam(extraParams?.preserve_thinking);
}

function isDisabledThinkingLevel(thinkingLevel: ProviderWrapStreamFnContext["thinkingLevel"]) {
  return thinkingLevel === "off";
}

function mapThinkingLevelToZaiReasoningEffort(
  thinkingLevel: ProviderWrapStreamFnContext["thinkingLevel"],
): "high" | "max" | undefined {
  switch (thinkingLevel) {
    case "low":
    case "medium":
    case "high":
    case "adaptive":
      return "high";
    case "xhigh":
    case "max":
      return "max";
    default:
      return undefined;
  }
}

function wrapZaiStreamFn(ctx: ProviderWrapStreamFnContext) {
  let streamFn = createToolStreamWrapper(ctx.streamFn, ctx.extraParams?.tool_stream !== false);
  const preserveThinking = shouldPreserveZaiThinking(ctx.extraParams);
  const reasoningEffort = isGlm52ModelId(ctx.modelId)
    ? mapThinkingLevelToZaiReasoningEffort(ctx.thinkingLevel)
    : undefined;

  if (!isDisabledThinkingLevel(ctx.thinkingLevel) && !preserveThinking && !reasoningEffort) {
    return streamFn;
  }

  streamFn = createPayloadPatchStreamWrapper(streamFn, ({ payload, model }) => {
    if (model.api !== "openai-completions" || model.provider !== PROVIDER_ID) {
      return;
    }

    if (isDisabledThinkingLevel(ctx.thinkingLevel)) {
      payload.thinking = { type: "disabled" };
      return;
    }

    if (reasoningEffort) {
      payload.reasoning_effort = reasoningEffort;
    }

    if (preserveThinking) {
      payload.thinking = { type: "enabled", clear_thinking: false };
    }
  });

  return streamFn;
}

async function promptForZaiEndpoint(ctx: ProviderAuthContext): Promise<ZaiEndpointId> {
  return await ctx.prompter.select<ZaiEndpointId>({
    message: "Select Z.AI endpoint",
    initialValue: "global",
    options: [
      { value: "global", label: "Global", hint: "Z.AI Global (api.z.ai)" },
      { value: "cn", label: "CN", hint: "Z.AI CN (open.bigmodel.cn)" },
      {
        value: "coding-global",
        label: "Coding-Plan-Global",
        hint: "GLM Coding Plan Global (api.z.ai)",
      },
      {
        value: "coding-cn",
        label: "Coding-Plan-CN",
        hint: "GLM Coding Plan CN (open.bigmodel.cn)",
      },
    ],
  });
}

async function runZaiApiKeyAuth(
  ctx: ProviderAuthContext,
  endpoint?: ZaiEndpointId,
): Promise<{
  profiles: Array<{ profileId: string; credential: ReturnType<typeof buildApiKeyCredential> }>;
  configPatch: ReturnType<typeof applyZaiProviderConfig>;
  defaultModel: string;
  notes?: string[];
}> {
  let capturedSecretInput: SecretInput | undefined;
  let capturedCredential = false;
  let capturedMode: "plaintext" | "ref" | undefined;
  const apiKey = await ensureApiKeyFromOptionEnvOrPrompt({
    token:
      normalizeOptionalSecretInput(ctx.opts?.zaiApiKey) ??
      normalizeOptionalSecretInput(ctx.opts?.token),
    tokenProvider: normalizeOptionalSecretInput(ctx.opts?.zaiApiKey)
      ? PROVIDER_ID
      : normalizeOptionalSecretInput(ctx.opts?.tokenProvider),
    secretInputMode:
      ctx.allowSecretRefPrompt === false
        ? (ctx.secretInputMode ?? "plaintext")
        : ctx.secretInputMode,
    config: ctx.config,
    expectedProviders: [PROVIDER_ID, "z-ai"],
    provider: PROVIDER_ID,
    envLabel: "ZAI_API_KEY",
    promptMessage: "Enter Z.AI API key",
    normalize: normalizeApiKeyInput,
    validate: validateApiKeyInput,
    prompter: ctx.prompter,
    setCredential: async (key, mode) => {
      capturedSecretInput = key;
      capturedCredential = true;
      capturedMode = mode;
    },
  });
  if (!capturedCredential) {
    throw new Error("Missing Z.AI API key.");
  }
  const credentialInput = capturedSecretInput ?? "";

  const detected = await detectZaiEndpoint({ apiKey, ...(endpoint ? { endpoint } : {}) });
  const modelIdOverride = detected?.modelId;
  const nextEndpoint = detected?.endpoint ?? endpoint ?? (await promptForZaiEndpoint(ctx));
  const preset = {
    ...(nextEndpoint ? { endpoint: nextEndpoint } : {}),
    ...(modelIdOverride ? { modelId: modelIdOverride } : {}),
  };
  return {
    profiles: [
      {
        profileId: PROFILE_ID,
        credential: buildApiKeyCredential(
          PROVIDER_ID,
          credentialInput,
          undefined,
          capturedMode ? { secretInputMode: capturedMode } : undefined,
        ),
      },
    ],
    configPatch: applyZaiProviderConfig(ctx.config, preset),
    defaultModel: `zai/${resolveZaiModelId(preset)}`,
    ...(detected?.note ? { notes: [detected.note] } : {}),
  };
}

async function runZaiApiKeyAuthNonInteractive(
  ctx: ProviderAuthMethodNonInteractiveContext,
  endpoint?: ZaiEndpointId,
) {
  const resolved = await ctx.resolveApiKey({
    provider: PROVIDER_ID,
    flagValue: normalizeOptionalSecretInput(ctx.opts.zaiApiKey),
    flagName: "--zai-api-key",
    envVar: "ZAI_API_KEY",
  });
  if (!resolved) {
    return null;
  }
  const detected = await detectZaiEndpoint({
    apiKey: resolved.key,
    ...(endpoint ? { endpoint } : {}),
  });
  const modelIdOverride = detected?.modelId;
  const nextEndpoint = detected?.endpoint ?? endpoint;

  if (resolved.source !== "profile") {
    const credential = ctx.toApiKeyCredential({
      provider: PROVIDER_ID,
      resolved,
    });
    if (!credential) {
      return null;
    }
    await upsertAuthProfileWithLockOrThrow({
      profileId: PROFILE_ID,
      credential,
      agentDir: ctx.agentDir,
    });
  }

  const next = applyAuthProfileConfig(ctx.config, {
    profileId: PROFILE_ID,
    provider: PROVIDER_ID,
    mode: "api_key",
  });
  return applyZaiConfig(next, {
    ...(nextEndpoint ? { endpoint: nextEndpoint } : {}),
    ...(modelIdOverride ? { modelId: modelIdOverride } : {}),
  });
}

function buildZaiApiKeyMethod(params: {
  id: string;
  choiceId: string;
  choiceLabel: string;
  choiceHint?: string;
  endpoint?: ZaiEndpointId;
}): ProviderAuthMethod {
  return {
    id: params.id,
    label: params.choiceLabel,
    hint: params.choiceHint,
    kind: "api_key",
    wizard: {
      choiceId: params.choiceId,
      choiceLabel: params.choiceLabel,
      ...(params.choiceHint ? { choiceHint: params.choiceHint } : {}),
      groupId: "zai",
      groupLabel: "Z.AI",
      groupHint: "GLM Coding Plan / Global / CN",
    },
    run: async (ctx) => await runZaiApiKeyAuth(ctx, params.endpoint),
    runNonInteractive: async (ctx) => await runZaiApiKeyAuthNonInteractive(ctx, params.endpoint),
  };
}

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "Z.AI Provider",
  description: "Bundled Z.AI provider plugin",
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Z.AI",
      aliases: ["z-ai", "z.ai"],
      docsPath: "/providers/models",
      envVars: ["ZAI_API_KEY", "Z_AI_API_KEY"],
      auth: [
        buildZaiApiKeyMethod({
          id: "api-key",
          choiceId: "zai-api-key",
          choiceLabel: "Z.AI API key",
        }),
        buildZaiApiKeyMethod({
          id: "coding-global",
          choiceId: "zai-coding-global",
          choiceLabel: "Coding-Plan-Global",
          choiceHint: "GLM Coding Plan Global (api.z.ai)",
          endpoint: "coding-global",
        }),
        buildZaiApiKeyMethod({
          id: "coding-cn",
          choiceId: "zai-coding-cn",
          choiceLabel: "Coding-Plan-CN",
          choiceHint: "GLM Coding Plan CN (open.bigmodel.cn)",
          endpoint: "coding-cn",
        }),
        buildZaiApiKeyMethod({
          id: "global",
          choiceId: "zai-global",
          choiceLabel: "Global",
          choiceHint: "Z.AI Global (api.z.ai)",
          endpoint: "global",
        }),
        buildZaiApiKeyMethod({
          id: "cn",
          choiceId: "zai-cn",
          choiceLabel: "CN",
          choiceHint: "Z.AI CN (open.bigmodel.cn)",
          endpoint: "cn",
        }),
      ],
      catalog: {
        order: "simple",
        run: (ctx) =>
          buildOpenAICompatibleProviderCatalog({
            ctx,
            providerId: PROVIDER_ID,
            buildProvider: buildZaiCatalogProvider,
            allowExplicitBaseUrl: true,
          }),
      },
      staticCatalog: {
        order: "simple",
        run: async () => ({ provider: buildZaiCatalogProvider() }),
      },
      resolveDynamicModel: (ctx) => resolveGlm5ForwardCompatModel(ctx),
      matchesContextOverflowError: ({ errorMessage }) =>
        /\b(?:tokens? in request more than max tokens? allowed|prompt exceeds max(?:imum)? length)\b/i.test(
          errorMessage,
        ),
      ...buildProviderReplayFamilyHooks({
        family: "openai-compatible",
        dropReasoningFromHistory: false,
      }),
      prepareExtraParams: (ctx) => defaultToolStreamExtraParams(ctx.extraParams),
      wrapStreamFn: (ctx) => wrapZaiStreamFn(ctx),
      resolveThinkingProfile,
      isModernModelRef: ({ modelId }) => {
        const lower = normalizeLowercaseStringOrEmpty(modelId);
        return (
          lower.startsWith("glm-5") ||
          lower.startsWith("glm-4.7") ||
          lower.startsWith("glm-4.7-flash") ||
          lower.startsWith("glm-4.7-flashx")
        );
      },
      resolveUsageAuth: async (ctx) => {
        const apiKey = ctx.resolveApiKeyFromConfigAndStore({
          providerIds: [PROVIDER_ID, "z-ai"],
          envDirect: [ctx.env.ZAI_API_KEY, ctx.env.Z_AI_API_KEY],
        });
        if (apiKey) {
          return { token: apiKey };
        }
        const legacyToken = resolveDeprecatedPiAgentAccessToken(ctx.env, ["z-ai", PROVIDER_ID]);
        return legacyToken ? { token: legacyToken } : null;
      },
      fetchUsageSnapshot: async (ctx) => await fetchZaiUsage(ctx.token, ctx.timeoutMs, ctx.fetchFn),
      isCacheTtlEligible: () => true,
    });
    api.registerMediaUnderstandingProvider(zaiMediaUnderstandingProvider);
  },
});
