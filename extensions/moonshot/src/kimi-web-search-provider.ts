import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-onboard";
import {
  buildSearchCacheKey,
  buildUnsupportedSearchFilterResponse,
  DEFAULT_SEARCH_COUNT,
  getScopedCredentialValue,
  MAX_SEARCH_COUNT,
  mergeScopedSearchConfig,
  readCachedSearchPayload,
  readConfiguredSecretString,
  readNumberParam,
  readProviderEnvValue,
  readStringParam,
  resolveProviderWebSearchPluginConfig,
  resolveSearchCacheTtlMs,
  resolveSearchCount,
  resolveSearchTimeoutSeconds,
  setScopedCredentialValue,
  setProviderWebSearchPluginConfigValue,
  type SearchConfigRecord,
  type WebSearchProviderPlugin,
  type WebSearchProviderSetupContext,
  type WebSearchProviderToolDefinition,
  withTrustedWebSearchEndpoint,
  wrapWebContent,
  writeCachedSearchPayload,
} from "openclaw/plugin-sdk/provider-web-search";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import {
  isNativeMoonshotBaseUrl,
  MOONSHOT_BASE_URL,
  MOONSHOT_CN_BASE_URL,
  MOONSHOT_DEFAULT_MODEL_ID,
} from "../provider-catalog.js";

const DEFAULT_KIMI_BASE_URL = MOONSHOT_BASE_URL;
const DEFAULT_KIMI_SEARCH_MODEL = MOONSHOT_DEFAULT_MODEL_ID;
/** Models that require explicit thinking disablement for web search.
 * Reasoning variants (kimi-k2-thinking, kimi-k2-thinking-turbo) are excluded
 * because they default to thinking-enabled and disabling it would defeat their
 * purpose; they are also unlikely to be used for web search. */
const KIMI_THINKING_MODELS = new Set(["kimi-k2.5"]);
const KIMI_WEB_SEARCH_TOOL = {
  type: "builtin_function",
  function: { name: "$web_search" },
} as const;

type KimiConfig = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
};

type KimiToolCall = {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
};

type KimiMessage = {
  role?: string;
  content?: string;
  reasoning_content?: string;
  tool_calls?: KimiToolCall[];
};

type KimiSearchResponse = {
  choices?: Array<{
    finish_reason?: string;
    message?: KimiMessage;
  }>;
  search_results?: Array<{
    title?: string;
    url?: string;
    content?: string;
  }>;
};

function resolveKimiConfig(searchConfig?: SearchConfigRecord): KimiConfig {
  const kimi = searchConfig?.kimi;
  return kimi && typeof kimi === "object" && !Array.isArray(kimi) ? (kimi as KimiConfig) : {};
}

function resolveKimiApiKey(kimi?: KimiConfig): string | undefined {
  return (
    readConfiguredSecretString(kimi?.apiKey, "tools.web.search.kimi.apiKey") ??
    readProviderEnvValue(["KIMI_API_KEY", "MOONSHOT_API_KEY"])
  );
}

function resolveKimiModel(kimi?: KimiConfig): string {
  const model = normalizeOptionalString(kimi?.model) ?? "";
  return model || DEFAULT_KIMI_SEARCH_MODEL;
}

function trimTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

function resolveKimiBaseUrl(kimi?: KimiConfig, openClawConfig?: OpenClawConfig): string {
  const explicitBaseUrl = normalizeOptionalString(kimi?.baseUrl) ?? "";
  if (explicitBaseUrl) {
    return trimTrailingSlashes(explicitBaseUrl) || DEFAULT_KIMI_BASE_URL;
  }

  const moonshotBaseUrl = openClawConfig?.models?.providers?.moonshot?.baseUrl;
  if (typeof moonshotBaseUrl === "string") {
    const normalizedMoonshotBaseUrl = trimTrailingSlashes(moonshotBaseUrl.trim());
    if (normalizedMoonshotBaseUrl && isNativeMoonshotBaseUrl(normalizedMoonshotBaseUrl)) {
      return normalizedMoonshotBaseUrl;
    }
  }

  return DEFAULT_KIMI_BASE_URL;
}

function extractKimiMessageText(message: KimiMessage | undefined): string | undefined {
  const content = message?.content?.trim();
  if (content) {
    return content;
  }
  const reasoning = message?.reasoning_content?.trim();
  return reasoning || undefined;
}

function extractKimiCitations(data: KimiSearchResponse): string[] {
  const citations = (data.search_results ?? [])
    .map((entry) => entry.url?.trim())
    .filter((url): url is string => Boolean(url));

  for (const toolCall of data.choices?.[0]?.message?.tool_calls ?? []) {
    const rawArguments = toolCall.function?.arguments;
    if (!rawArguments) {
      continue;
    }
    try {
      const parsed = JSON.parse(rawArguments) as {
        search_results?: Array<{ url?: string }>;
        url?: string;
      };
      const parsedUrl = normalizeOptionalString(parsed.url);
      if (parsedUrl) {
        citations.push(parsedUrl);
      }
      for (const result of parsed.search_results ?? []) {
        const resultUrl = normalizeOptionalString(result.url);
        if (resultUrl) {
          citations.push(resultUrl);
        }
      }
    } catch {
      // ignore malformed tool arguments
    }
  }

  return [...new Set(citations)];
}

function extractKimiToolResultContent(toolCall: KimiToolCall): string | undefined {
  const rawArguments = toolCall.function?.arguments;
  if (typeof rawArguments !== "string" || rawArguments.trim().length === 0) {
    return undefined;
  }
  return rawArguments;
}

async function runKimiSearch(params: {
  query: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutSeconds: number;
}): Promise<{ content: string; citations: string[] }> {
  const endpoint = `${params.baseUrl.trim().replace(/\/$/, "")}/chat/completions`;
  const messages: Array<Record<string, unknown>> = [{ role: "user", content: params.query }];
  const collectedCitations = new Set<string>();

  for (let round = 0; round < 3; round += 1) {
    const next = await withTrustedWebSearchEndpoint(
      {
        url: endpoint,
        timeoutSeconds: params.timeoutSeconds,
        init: {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${params.apiKey}`,
          },
          body: JSON.stringify({
            model: params.model,
            ...(KIMI_THINKING_MODELS.has(params.model) ? { thinking: { type: "disabled" } } : {}),
            messages,
            tools: [KIMI_WEB_SEARCH_TOOL],
          }),
        },
      },
      async (
        res,
      ): Promise<{ done: true; content: string; citations: string[] } | { done: false }> => {
        if (!res.ok) {
          const detail = await res.text();
          throw new Error(`Kimi API error (${res.status}): ${detail || res.statusText}`);
        }

        const data = (await res.json()) as KimiSearchResponse;
        for (const citation of extractKimiCitations(data)) {
          collectedCitations.add(citation);
        }
        const choice = data.choices?.[0];
        const message = choice?.message;
        const text = extractKimiMessageText(message);
        const toolCalls = message?.tool_calls ?? [];

        if (choice?.finish_reason !== "tool_calls" || toolCalls.length === 0) {
          return { done: true, content: text ?? "No response", citations: [...collectedCitations] };
        }

        messages.push({
          role: "assistant",
          content: message?.content ?? "",
          ...(message?.reasoning_content ? { reasoning_content: message.reasoning_content } : {}),
          tool_calls: toolCalls,
        });

        let pushed = false;
        for (const toolCall of toolCalls) {
          const toolCallId = toolCall.id?.trim();
          const toolCallName = toolCall.function?.name?.trim();
          const toolContent = extractKimiToolResultContent(toolCall);
          if (!toolCallId || !toolCallName || !toolContent) {
            continue;
          }
          pushed = true;
          messages.push({
            role: "tool",
            tool_call_id: toolCallId,
            name: toolCallName,
            content: toolContent,
          });
        }
        if (!pushed) {
          return { done: true, content: text ?? "No response", citations: [...collectedCitations] };
        }
        return { done: false };
      },
    );

    if (next.done) {
      return { content: next.content, citations: next.citations };
    }
  }

  return {
    content: "Search completed but no final answer was produced.",
    citations: [...collectedCitations],
  };
}

function createKimiSchema() {
  return Type.Object({
    query: Type.String({ description: "Search query string." }),
    count: Type.Optional(
      Type.Number({
        description: "Number of results to return (1-10).",
        minimum: 1,
        maximum: MAX_SEARCH_COUNT,
      }),
    ),
    country: Type.Optional(Type.String({ description: "Not supported by Kimi." })),
    language: Type.Optional(Type.String({ description: "Not supported by Kimi." })),
    freshness: Type.Optional(Type.String({ description: "Not supported by Kimi." })),
    date_after: Type.Optional(Type.String({ description: "Not supported by Kimi." })),
    date_before: Type.Optional(Type.String({ description: "Not supported by Kimi." })),
  });
}

function createKimiToolDefinition(
  searchConfig: SearchConfigRecord | undefined,
  openClawConfig: OpenClawConfig | undefined,
): WebSearchProviderToolDefinition {
  return {
    description:
      "Search the web using Kimi by Moonshot. Returns AI-synthesized answers with citations from native $web_search.",
    parameters: createKimiSchema(),
    execute: async (args) => {
      const params = args;
      const unsupportedResponse = buildUnsupportedSearchFilterResponse(params, "kimi");
      if (unsupportedResponse) {
        return unsupportedResponse;
      }

      const kimiConfig = resolveKimiConfig(searchConfig);
      const apiKey = resolveKimiApiKey(kimiConfig);
      if (!apiKey) {
        return {
          error: "missing_kimi_api_key",
          message:
            "web_search (kimi) needs a Moonshot API key. Set KIMI_API_KEY or MOONSHOT_API_KEY in the Gateway environment, or configure tools.web.search.kimi.apiKey.",
          docs: "https://docs.openclaw.ai/tools/web",
        };
      }

      const query = readStringParam(params, "query", { required: true });
      const count =
        readNumberParam(params, "count", { integer: true }) ??
        searchConfig?.maxResults ??
        undefined;
      const model = resolveKimiModel(kimiConfig);
      const baseUrl = resolveKimiBaseUrl(kimiConfig, openClawConfig);
      const cacheKey = buildSearchCacheKey([
        "kimi",
        query,
        resolveSearchCount(count, DEFAULT_SEARCH_COUNT),
        baseUrl,
        model,
      ]);
      const cached = readCachedSearchPayload(cacheKey);
      if (cached) {
        return cached;
      }

      const start = Date.now();
      const result = await runKimiSearch({
        query,
        apiKey,
        baseUrl,
        model,
        timeoutSeconds: resolveSearchTimeoutSeconds(searchConfig),
      });
      const payload = {
        query,
        provider: "kimi",
        model,
        tookMs: Date.now() - start,
        externalContent: {
          untrusted: true,
          source: "web_search",
          provider: "kimi",
          wrapped: true,
        },
        content: wrapWebContent(result.content),
        citations: result.citations,
      };
      writeCachedSearchPayload(cacheKey, payload, resolveSearchCacheTtlMs(searchConfig));
      return payload;
    },
  };
}

async function runKimiSearchProviderSetup(
  ctx: WebSearchProviderSetupContext,
): Promise<WebSearchProviderSetupContext["config"]> {
  const existingPluginConfig = resolveProviderWebSearchPluginConfig(ctx.config, "moonshot");
  const existingBaseUrl = normalizeOptionalString(existingPluginConfig?.baseUrl) ?? "";
  // Normalize trailing slashes so initialValue matches canonical option values.
  const normalizedBaseUrl = existingBaseUrl.replace(/\/+$/, "");
  const existingModel = normalizeOptionalString(existingPluginConfig?.model) ?? "";

  // Region selection (baseUrl)
  const isCustomBaseUrl = normalizedBaseUrl && !isNativeMoonshotBaseUrl(normalizedBaseUrl);
  const regionOptions: Array<{ value: string; label: string; hint?: string }> = [];
  if (isCustomBaseUrl) {
    regionOptions.push({
      value: normalizedBaseUrl,
      label: `Keep current (${normalizedBaseUrl})`,
      hint: "custom endpoint",
    });
  }
  regionOptions.push(
    {
      value: MOONSHOT_BASE_URL,
      label: "Moonshot API key (.ai)",
      hint: "api.moonshot.ai",
    },
    {
      value: MOONSHOT_CN_BASE_URL,
      label: "Moonshot API key (.cn)",
      hint: "api.moonshot.cn",
    },
  );

  const regionChoice = await ctx.prompter.select<string>({
    message: "Kimi API region",
    options: regionOptions,
    initialValue: normalizedBaseUrl || MOONSHOT_BASE_URL,
  });
  const baseUrl = regionChoice;

  // Model selection
  const currentModelLabel = existingModel
    ? `Keep current (moonshot/${existingModel})`
    : `Use default (moonshot/${DEFAULT_KIMI_SEARCH_MODEL})`;
  const modelChoice = await ctx.prompter.select<string>({
    message: "Kimi web search model",
    options: [
      {
        value: "__keep__",
        label: currentModelLabel,
      },
      {
        value: "__custom__",
        label: "Enter model manually",
      },
      {
        value: DEFAULT_KIMI_SEARCH_MODEL,
        label: `moonshot/${DEFAULT_KIMI_SEARCH_MODEL}`,
      },
    ],
    initialValue: "__keep__",
  });

  let model: string;
  if (modelChoice === "__keep__") {
    model = existingModel || DEFAULT_KIMI_SEARCH_MODEL;
  } else if (modelChoice === "__custom__") {
    const customModel = await ctx.prompter.text({
      message: "Kimi model name",
      initialValue: existingModel || DEFAULT_KIMI_SEARCH_MODEL,
      placeholder: DEFAULT_KIMI_SEARCH_MODEL,
    });
    model = customModel?.trim() || DEFAULT_KIMI_SEARCH_MODEL;
  } else {
    model = modelChoice;
  }

  // Write baseUrl and model into plugins.entries.moonshot.config.webSearch
  const next = { ...ctx.config };
  setProviderWebSearchPluginConfigValue(next, "moonshot", "baseUrl", baseUrl);
  setProviderWebSearchPluginConfigValue(next, "moonshot", "model", model);
  return next;
}

export function createKimiWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: "kimi",
    label: "Kimi (Moonshot)",
    hint: "Requires Moonshot / Kimi API key · Moonshot web search",
    onboardingScopes: ["text-inference"],
    credentialLabel: "Moonshot / Kimi API key",
    envVars: ["KIMI_API_KEY", "MOONSHOT_API_KEY"],
    placeholder: "sk-...",
    signupUrl: "https://platform.moonshot.cn/",
    docsUrl: "https://docs.openclaw.ai/tools/web",
    autoDetectOrder: 40,
    credentialPath: "plugins.entries.moonshot.config.webSearch.apiKey",
    inactiveSecretPaths: ["plugins.entries.moonshot.config.webSearch.apiKey"],
    getCredentialValue: (searchConfig) => getScopedCredentialValue(searchConfig, "kimi"),
    setCredentialValue: (searchConfigTarget, value) =>
      setScopedCredentialValue(searchConfigTarget, "kimi", value),
    getConfiguredCredentialValue: (config) =>
      resolveProviderWebSearchPluginConfig(config, "moonshot")?.apiKey,
    setConfiguredCredentialValue: (configTarget, value) => {
      setProviderWebSearchPluginConfigValue(configTarget, "moonshot", "apiKey", value);
    },
    runSetup: runKimiSearchProviderSetup,
    createTool: (ctx) =>
      createKimiToolDefinition(
        mergeScopedSearchConfig(
          ctx.searchConfig as SearchConfigRecord | undefined,
          "kimi",
          resolveProviderWebSearchPluginConfig(ctx.config, "moonshot"),
        ) as SearchConfigRecord | undefined,
        ctx.config,
      ),
  };
}

export const __testing = {
  resolveKimiApiKey,
  resolveKimiModel,
  resolveKimiBaseUrl,
  extractKimiCitations,
  extractKimiToolResultContent,
} as const;
