import { Type } from "@sinclair/typebox";
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
  resolveCitationRedirectUrl,
  resolveProviderWebSearchPluginConfig,
  resolveSearchCacheTtlMs,
  resolveSearchCount,
  resolveSearchTimeoutSeconds,
  setScopedCredentialValue,
  setProviderWebSearchPluginConfigValue,
  type SearchConfigRecord,
  type WebSearchProviderPlugin,
  type WebSearchProviderToolDefinition,
  withTrustedWebSearchEndpoint,
  wrapWebContent,
  writeCachedSearchPayload,
} from "openclaw/plugin-sdk/provider-web-search";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { DEFAULT_GOOGLE_API_BASE_URL } from "../api.js";

const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_API_BASE = DEFAULT_GOOGLE_API_BASE_URL;

type GeminiConfig = {
  apiKey?: string;
  model?: string;
};

type GeminiGroundingResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
    groundingMetadata?: {
      groundingChunks?: Array<{
        web?: {
          uri?: string;
          title?: string;
        };
      }>;
    };
  }>;
  error?: {
    code?: number;
    message?: string;
    status?: string;
  };
};

function resolveGeminiConfig(searchConfig?: SearchConfigRecord): GeminiConfig {
  const gemini = searchConfig?.gemini;
  return gemini && typeof gemini === "object" && !Array.isArray(gemini)
    ? (gemini as GeminiConfig)
    : {};
}

function resolveGeminiApiKey(gemini?: GeminiConfig): string | undefined {
  return (
    readConfiguredSecretString(gemini?.apiKey, "tools.web.search.gemini.apiKey") ??
    readProviderEnvValue(["GEMINI_API_KEY"])
  );
}

function resolveGeminiModel(gemini?: GeminiConfig): string {
  const model = normalizeOptionalString(gemini?.model) ?? "";
  return model || DEFAULT_GEMINI_MODEL;
}

async function runGeminiSearch(params: {
  query: string;
  apiKey: string;
  model: string;
  timeoutSeconds: number;
}): Promise<{ content: string; citations: Array<{ url: string; title?: string }> }> {
  const endpoint = `${GEMINI_API_BASE}/models/${params.model}:generateContent`;

  return withTrustedWebSearchEndpoint(
    {
      url: endpoint,
      timeoutSeconds: params.timeoutSeconds,
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": params.apiKey,
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: params.query }] }],
          tools: [{ google_search: {} }],
        }),
      },
    },
    async (res) => {
      if (!res.ok) {
        const safeDetail = ((await res.text()) || res.statusText).replace(
          /key=[^&\s]+/gi,
          "key=***",
        );
        throw new Error(`Gemini API error (${res.status}): ${safeDetail}`);
      }

      let data: GeminiGroundingResponse;
      try {
        data = (await res.json()) as GeminiGroundingResponse;
      } catch (error) {
        const safeError = String(error).replace(/key=[^&\s]+/gi, "key=***");
        throw new Error(`Gemini API returned invalid JSON: ${safeError}`, { cause: error });
      }

      if (data.error) {
        const rawMessage = data.error.message || data.error.status || "unknown";
        throw new Error(
          `Gemini API error (${data.error.code}): ${rawMessage.replace(/key=[^&\s]+/gi, "key=***")}`,
        );
      }

      const candidate = data.candidates?.[0];
      const content =
        candidate?.content?.parts
          ?.map((part) => part.text)
          .filter(Boolean)
          .join("\n") ?? "No response";
      const rawCitations = (candidate?.groundingMetadata?.groundingChunks ?? [])
        .filter((chunk) => chunk.web?.uri)
        .map((chunk) => ({
          url: chunk.web!.uri!,
          title: chunk.web?.title || undefined,
        }));

      const citations: Array<{ url: string; title?: string }> = [];
      for (let index = 0; index < rawCitations.length; index += 10) {
        const batch = rawCitations.slice(index, index + 10);
        const resolved = await Promise.all(
          batch.map(async (citation) => ({
            ...citation,
            url: await resolveCitationRedirectUrl(citation.url),
          })),
        );
        citations.push(...resolved);
      }

      return { content, citations };
    },
  );
}

function createGeminiSchema() {
  return Type.Object({
    query: Type.String({ description: "Search query string." }),
    count: Type.Optional(
      Type.Number({
        description: "Number of results to return (1-10).",
        minimum: 1,
        maximum: MAX_SEARCH_COUNT,
      }),
    ),
    country: Type.Optional(Type.String({ description: "Not supported by Gemini." })),
    language: Type.Optional(Type.String({ description: "Not supported by Gemini." })),
    freshness: Type.Optional(Type.String({ description: "Not supported by Gemini." })),
    date_after: Type.Optional(Type.String({ description: "Not supported by Gemini." })),
    date_before: Type.Optional(Type.String({ description: "Not supported by Gemini." })),
  });
}

function createGeminiToolDefinition(
  searchConfig?: SearchConfigRecord,
): WebSearchProviderToolDefinition {
  return {
    description:
      "Search the web using Gemini with Google Search grounding. Returns AI-synthesized answers with citations from Google Search.",
    parameters: createGeminiSchema(),
    execute: async (args) => {
      const params = args;
      const unsupportedResponse = buildUnsupportedSearchFilterResponse(params, "gemini");
      if (unsupportedResponse) {
        return unsupportedResponse;
      }

      const geminiConfig = resolveGeminiConfig(searchConfig);
      const apiKey = resolveGeminiApiKey(geminiConfig);
      if (!apiKey) {
        return {
          error: "missing_gemini_api_key",
          message:
            "web_search (gemini) needs an API key. Set GEMINI_API_KEY in the Gateway environment, or configure tools.web.search.gemini.apiKey.",
          docs: "https://docs.openclaw.ai/tools/web",
        };
      }

      const query = readStringParam(params, "query", { required: true });
      const count =
        readNumberParam(params, "count", { integer: true }) ??
        searchConfig?.maxResults ??
        undefined;
      const model = resolveGeminiModel(geminiConfig);
      const cacheKey = buildSearchCacheKey([
        "gemini",
        query,
        resolveSearchCount(count, DEFAULT_SEARCH_COUNT),
        model,
      ]);
      const cached = readCachedSearchPayload(cacheKey);
      if (cached) {
        return cached;
      }

      const start = Date.now();
      const result = await runGeminiSearch({
        query,
        apiKey,
        model,
        timeoutSeconds: resolveSearchTimeoutSeconds(searchConfig),
      });
      const payload = {
        query,
        provider: "gemini",
        model,
        tookMs: Date.now() - start,
        externalContent: {
          untrusted: true,
          source: "web_search",
          provider: "gemini",
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

export function createGeminiWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: "gemini",
    label: "Gemini (Google Search)",
    hint: "Requires Google Gemini API key · Google Search grounding",
    onboardingScopes: ["text-inference"],
    credentialLabel: "Google Gemini API key",
    envVars: ["GEMINI_API_KEY"],
    placeholder: "AIza...",
    signupUrl: "https://aistudio.google.com/apikey",
    docsUrl: "https://docs.openclaw.ai/tools/web",
    autoDetectOrder: 20,
    credentialPath: "plugins.entries.google.config.webSearch.apiKey",
    inactiveSecretPaths: ["plugins.entries.google.config.webSearch.apiKey"],
    getCredentialValue: (searchConfig) => getScopedCredentialValue(searchConfig, "gemini"),
    setCredentialValue: (searchConfigTarget, value) =>
      setScopedCredentialValue(searchConfigTarget, "gemini", value),
    getConfiguredCredentialValue: (config) =>
      resolveProviderWebSearchPluginConfig(config, "google")?.apiKey,
    setConfiguredCredentialValue: (configTarget, value) => {
      setProviderWebSearchPluginConfigValue(configTarget, "google", "apiKey", value);
    },
    createTool: (ctx) =>
      createGeminiToolDefinition(
        mergeScopedSearchConfig(
          ctx.searchConfig as SearchConfigRecord | undefined,
          "gemini",
          resolveProviderWebSearchPluginConfig(ctx.config, "google"),
        ) as SearchConfigRecord | undefined,
      ),
  };
}

export const __testing = {
  resolveGeminiApiKey,
  resolveGeminiModel,
} as const;
