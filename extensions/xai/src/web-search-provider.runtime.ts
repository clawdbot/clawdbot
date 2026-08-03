// Xai provider module implements model/runtime integration.
import { resolveDefaultAgentDir } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  coerceSecretRef,
  ensureAuthProfileStore,
  listUsableProviderAuthProfileIds,
} from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  DEFAULT_CACHE_TTL_MINUTES,
  formatCliCommand,
  getScopedCredentialValue,
  mergeScopedSearchConfig,
  normalizeCacheKey,
  readCache,
  readPositiveIntegerParam,
  readStringParam,
  resolveCacheTtlMs,
  resolveProviderWebSearchPluginConfig,
  resolveTimeoutSeconds,
  resolveWebSearchProviderCredential,
  type WebSearchProviderSetupContext,
  writeCache,
} from "openclaw/plugin-sdk/provider-web-search";
import {
  buildXaiWebSearchPayload,
  extractXaiWebSearchContent,
  requestXaiWebSearch,
  resolveXaiInlineCitations,
  resolveXaiWebSearchEndpoint,
  resolveXaiWebSearchModel,
} from "./web-search-shared.js";
import { resolveEffectiveXSearchConfig, setPluginXSearchConfigValue } from "./x-search-config.js";
import { XAI_DEFAULT_X_SEARCH_MODEL } from "./x-search-shared.js";

const XAI_WEB_SEARCH_CACHE = new Map<
  string,
  { value: Record<string, unknown>; insertedAt: number; expiresAt: number }
>();
const XAI_WEB_SEARCH_DEFAULT_TIMEOUT_SECONDS = 60;
const XAI_PROVIDER_ID = "xai";

const X_SEARCH_MODEL_OPTIONS = [
  {
    value: XAI_DEFAULT_X_SEARCH_MODEL,
    label: XAI_DEFAULT_X_SEARCH_MODEL,
    hint: "default · reasoning disabled",
  },
] as const;

function resolveXSearchConfigRecord(
  config?: WebSearchProviderSetupContext["config"],
): Record<string, unknown> | undefined {
  return resolveEffectiveXSearchConfig(config);
}

export async function runXaiSearchProviderSetup(
  ctx: WebSearchProviderSetupContext,
): Promise<WebSearchProviderSetupContext["config"]> {
  const existingXSearch = resolveXSearchConfigRecord(ctx.config);
  if (existingXSearch?.enabled === false) {
    return ctx.config;
  }

  await ctx.prompter.note(
    [
      "x_search lets your agent search X (formerly Twitter) posts via xAI.",
      "It reuses the same xAI credential you configured for Grok web search.",
      `You can change this later with ${formatCliCommand("openclaw configure --section web")}.`,
    ].join("\n"),
    "X search",
  );

  const enableChoice = await ctx.prompter.select<"yes" | "skip">({
    message: "Enable x_search too?",
    options: [
      {
        value: "yes",
        label: "Yes, enable x_search",
        hint: "Search X posts with the same xAI credential",
      },
      {
        value: "skip",
        label: "Skip for now",
        hint: "Keep Grok web_search only",
      },
    ],
    initialValue: existingXSearch?.enabled === true || ctx.quickstartDefaults ? "yes" : "skip",
  });

  if (enableChoice === "skip") {
    return ctx.config;
  }

  const existingModel =
    typeof existingXSearch?.model === "string" && existingXSearch.model.trim()
      ? existingXSearch.model.trim()
      : "";
  const knownModel = X_SEARCH_MODEL_OPTIONS.find((entry) => entry.value === existingModel)?.value;
  const modelPick = await ctx.prompter.select<string>({
    message: "Grok model for x_search",
    options: [
      ...X_SEARCH_MODEL_OPTIONS,
      { value: "__custom__", label: "Enter custom model name", hint: "" },
    ],
    initialValue: knownModel ?? XAI_DEFAULT_X_SEARCH_MODEL,
  });

  let model = modelPick;
  if (modelPick === "__custom__") {
    const customModel = await ctx.prompter.text({
      message: "Custom Grok model name",
      initialValue: existingModel || XAI_DEFAULT_X_SEARCH_MODEL,
      placeholder: XAI_DEFAULT_X_SEARCH_MODEL,
    });
    model = customModel.trim() || XAI_DEFAULT_X_SEARCH_MODEL;
  }

  const next = structuredClone(ctx.config);
  setPluginXSearchConfigValue(next, "enabled", true);
  setPluginXSearchConfigValue(next, "model", model || XAI_DEFAULT_X_SEARCH_MODEL);
  return next;
}

function runXaiWebSearch(params: {
  query: string;
  model: string;
  endpoint: string;
  apiKey: string;
  timeoutSeconds: number;
  inlineCitations: boolean;
  cacheTtlMs: number;
}): Promise<Record<string, unknown>> {
  const cacheKey = normalizeCacheKey(
    `grok:${params.endpoint}:${params.model}:${String(params.inlineCitations)}:${params.query}`,
  );
  const cached = readCache(XAI_WEB_SEARCH_CACHE, cacheKey);
  if (cached) {
    return Promise.resolve({ ...cached.value, cached: true });
  }

  return (async () => {
    const startedAt = Date.now();
    const result = await requestXaiWebSearch({
      query: params.query,
      model: params.model,
      apiKey: params.apiKey,
      endpoint: params.endpoint,
      timeoutSeconds: params.timeoutSeconds,
      inlineCitations: params.inlineCitations,
    });
    const payload = buildXaiWebSearchPayload({
      query: params.query,
      provider: "grok",
      model: params.model,
      tookMs: Date.now() - startedAt,
      content: result.content,
      citations: result.citations,
      inlineCitations: result.inlineCitations,
    });

    writeCache(XAI_WEB_SEARCH_CACHE, cacheKey, payload, params.cacheTtlMs);
    return payload;
  })();
}

function resolveXaiToolSearchConfig(ctx: {
  config?: Record<string, unknown>;
  searchConfig?: Record<string, unknown>;
}) {
  return mergeScopedSearchConfig(
    ctx.searchConfig,
    "grok",
    resolveProviderWebSearchPluginConfig(ctx.config, "xai"),
  );
}

function resolveXaiWebSearchCredential(searchConfig?: Record<string, unknown>): string | undefined {
  return resolveWebSearchProviderCredential({
    credentialValue: getScopedCredentialValue(searchConfig, "grok"),
    path: "plugins.entries.xai.config.webSearch.apiKey",
    envVars: ["XAI_API_KEY"],
  });
}

function resolveConfiguredXaiWebSearchCredential(
  searchConfig?: Record<string, unknown>,
): string | undefined {
  return resolveWebSearchProviderCredential({
    credentialValue: getScopedCredentialValue(searchConfig, "grok"),
    path: "plugins.entries.xai.config.webSearch.apiKey",
    envVars: [],
  });
}

function hasConfiguredXaiWebSearchCredentialRef(searchConfig?: Record<string, unknown>): boolean {
  return coerceSecretRef(getScopedCredentialValue(searchConfig, "grok")) !== null;
}

type XaiResolvedWebSearchAuth = {
  apiKey: string;
  mode?: "api-key" | "oauth" | "token" | "aws-sdk";
  profileId?: string;
};

async function resolveXaiProviderAuthCredential(params: {
  config?: Record<string, unknown>;
  agentDir?: string;
  credentialPrecedence?: "profile-first" | "env-first";
  forceRefresh?: boolean;
  profileId?: string;
}): Promise<XaiResolvedWebSearchAuth | undefined> {
  try {
    const config = params.config as OpenClawConfig | undefined;
    const agentDir =
      params.agentDir?.trim() || (config ? resolveDefaultAgentDir(config) : undefined);
    const resolved = await resolveApiKeyForProvider({
      provider: XAI_PROVIDER_ID,
      cfg: config,
      ...(agentDir ? { agentDir } : {}),
      ...(params.profileId
        ? {
            profileId: params.profileId,
            lockedProfile: true,
          }
        : {}),
      ...(params.forceRefresh ? { forceRefresh: true } : {}),
      ...(params.credentialPrecedence ? { credentialPrecedence: params.credentialPrecedence } : {}),
    });
    const apiKey = typeof resolved.apiKey === "string" ? resolved.apiKey.trim() : "";
    if (!apiKey) {
      return undefined;
    }
    return {
      apiKey,
      mode: resolved.mode,
      ...(resolved.profileId ? { profileId: resolved.profileId } : {}),
    };
  } catch {
    return undefined;
  }
}

async function resolveXaiProviderApiKeyProfileFallback(params: {
  config?: Record<string, unknown>;
  agentDir?: string;
}): Promise<XaiResolvedWebSearchAuth | undefined> {
  const config = params.config as OpenClawConfig | undefined;
  const usableProfiles = listUsableProviderAuthProfileIds({
    agentDir: params.agentDir,
    cfg: config,
    provider: XAI_PROVIDER_ID,
  });
  if (!usableProfiles.agentDir || usableProfiles.profileIds.length === 0) {
    return undefined;
  }

  const store = ensureAuthProfileStore(usableProfiles.agentDir, {
    allowKeychainPrompt: false,
  });
  for (const profileId of usableProfiles.profileIds) {
    const profile = store.profiles[profileId];
    if (!profile || profile.provider !== XAI_PROVIDER_ID || profile.type === "oauth") {
      continue;
    }
    const resolved = await resolveXaiProviderAuthCredential({
      agentDir: usableProfiles.agentDir,
      config: params.config,
      profileId,
    });
    if (resolved?.apiKey && resolved.mode !== "oauth") {
      return resolved;
    }
  }

  return undefined;
}

async function resolveXaiWebSearchAuth(
  ctx: { config?: Record<string, unknown>; agentDir?: string },
  searchConfig?: Record<string, unknown>,
  options?: { forceRefresh?: boolean; profileId?: string },
): Promise<XaiResolvedWebSearchAuth | undefined> {
  const providerAuth = await resolveXaiProviderAuthCredential({
    agentDir: ctx.agentDir,
    config: ctx.config,
    forceRefresh: options?.forceRefresh,
    profileId: options?.profileId,
  });
  if (providerAuth?.mode === "oauth") {
    return providerAuth;
  }

  const configured = resolveConfiguredXaiWebSearchCredential(searchConfig);
  if (configured) {
    return {
      apiKey: configured,
      mode: "api-key",
    };
  }
  if (hasConfiguredXaiWebSearchCredentialRef(searchConfig)) {
    return undefined;
  }

  return providerAuth;
}

async function resolveXaiWebSearchApiKeyFallback(
  ctx: { config?: Record<string, unknown>; agentDir?: string },
  searchConfig?: Record<string, unknown>,
): Promise<XaiResolvedWebSearchAuth | undefined> {
  const configured = resolveConfiguredXaiWebSearchCredential(searchConfig);
  if (configured) {
    return {
      apiKey: configured,
      mode: "api-key",
    };
  }
  if (hasConfiguredXaiWebSearchCredentialRef(searchConfig)) {
    return undefined;
  }

  const providerAuth = await resolveXaiProviderAuthCredential({
    agentDir: ctx.agentDir,
    config: ctx.config,
    credentialPrecedence: "env-first",
  });
  if (providerAuth?.apiKey && providerAuth.mode !== "oauth") {
    return providerAuth;
  }

  return await resolveXaiProviderApiKeyProfileFallback({
    agentDir: ctx.agentDir,
    config: ctx.config,
  });
}

function isXaiUnauthorizedError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("xAI API error (401)");
}

function resolveXaiWebSearchTimeoutSeconds(searchConfig?: Record<string, unknown>): number {
  return resolveTimeoutSeconds(
    searchConfig?.timeoutSeconds,
    XAI_WEB_SEARCH_DEFAULT_TIMEOUT_SECONDS,
  );
}

export async function executeXaiWebSearchProviderTool(
  ctx: {
    config?: Record<string, unknown>;
    searchConfig?: Record<string, unknown>;
    agentDir?: string;
  },
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const searchConfig = resolveXaiToolSearchConfig(ctx);
  const auth = await resolveXaiWebSearchAuth(ctx, searchConfig);

  if (!auth) {
    return {
      error: "missing_xai_api_key",
      message:
        "web_search (grok) needs xAI credentials. Run `openclaw onboard --auth-choice xai-oauth` to sign in with Grok, run `openclaw onboard --auth-choice xai-api-key`, set `XAI_API_KEY` in the Gateway environment, or configure `plugins.entries.xai.config.webSearch.apiKey`. If you do not want to configure search credentials, use web_fetch for a specific URL or the browser tool for interactive pages.",
      docs: "https://docs.openclaw.ai/tools/web",
    };
  }

  const query = readStringParam(args, "query", { required: true });
  void readPositiveIntegerParam(args, "count", {
    max: 10,
    message: "count must be an integer from 1 to 10.",
  });

  const request = {
    query,
    model: resolveXaiWebSearchModel(searchConfig),
    endpoint: resolveXaiWebSearchEndpoint(searchConfig),
    timeoutSeconds: resolveXaiWebSearchTimeoutSeconds(searchConfig),
    inlineCitations: resolveXaiInlineCitations(searchConfig),
    cacheTtlMs: resolveCacheTtlMs(searchConfig?.cacheTtlMinutes, DEFAULT_CACHE_TTL_MINUTES),
  };
  try {
    return await runXaiWebSearch({
      ...request,
      apiKey: auth.apiKey,
    });
  } catch (error) {
    if (!isXaiUnauthorizedError(error) || !auth.profileId) {
      throw error;
    }
    if (auth.mode === "oauth") {
      const refreshed = await resolveXaiWebSearchAuth(ctx, searchConfig, {
        forceRefresh: true,
        profileId: auth.profileId,
      });
      if (refreshed?.apiKey && refreshed.apiKey !== auth.apiKey) {
        return await runXaiWebSearch({
          ...request,
          apiKey: refreshed.apiKey,
        });
      }
    }
    const fallback = await resolveXaiWebSearchApiKeyFallback(ctx, searchConfig);
    if (!fallback?.apiKey || fallback.apiKey === auth.apiKey) {
      throw error;
    }
    return await runXaiWebSearch({
      ...request,
      apiKey: fallback.apiKey,
    });
  }
}

export const testing = {
  buildXaiWebSearchPayload,
  extractXaiWebSearchContent,
  resolveXaiToolSearchConfig,
  resolveXaiWebSearchAuth,
  resolveXaiInlineCitations,
  resolveXaiWebSearchCredential,
  resolveXaiWebSearchEndpoint,
  resolveXaiWebSearchModel,
  resolveXaiWebSearchTimeoutSeconds,
  requestXaiWebSearch,
};
export { testing as __testing };
