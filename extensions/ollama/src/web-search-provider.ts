import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  isNonSecretApiKeyMarker,
  normalizeOptionalSecretInput,
} from "openclaw/plugin-sdk/provider-auth";
import { resolveEnvApiKey } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  enablePluginInConfig,
  readNumberParam,
  readResponseText,
  readStringParam,
  resolveProviderWebSearchPluginConfig,
  resolveSearchCount,
  resolveSiteName,
  truncateText,
  wrapWebContent,
  type WebSearchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-search";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { Type } from "typebox";
import { OLLAMA_DEFAULT_BASE_URL } from "./defaults.js";
import {
  buildOllamaBaseUrlSsrFPolicy,
  fetchOllamaModels,
  resolveOllamaApiBase,
} from "./provider-models.js";
import { checkOllamaCloudAuth } from "./setup.js";

const OLLAMA_WEB_SEARCH_SCHEMA = Type.Object(
  {
    query: Type.String({ description: "Search query string." }),
    count: Type.Optional(
      Type.Number({
        description: "Number of results to return (1-10).",
        minimum: 1,
        maximum: 10,
      }),
    ),
  },
  { additionalProperties: false },
);

const OLLAMA_WEB_SEARCH_PATH = "/api/web_search";
const DEFAULT_OLLAMA_WEB_SEARCH_COUNT = 5;
const DEFAULT_OLLAMA_WEB_SEARCH_TIMEOUT_MS = 15_000;
const OLLAMA_WEB_SEARCH_SNIPPET_MAX_CHARS = 300;

type OllamaWebSearchResult = {
  title?: string;
  url?: string;
  content?: string;
};

type OllamaWebSearchResponse = {
  results?: OllamaWebSearchResult[];
};

function resolveOllamaWebSearchApiKey(config?: OpenClawConfig): string | undefined {
  const providerApiKey = normalizeOptionalSecretInput(config?.models?.providers?.ollama?.apiKey);
  if (providerApiKey && !isNonSecretApiKeyMarker(providerApiKey)) {
    return providerApiKey;
  }
  return resolveEnvApiKey("ollama")?.apiKey;
}

function resolveOllamaWebSearchBaseUrl(config?: OpenClawConfig): string {
  const pluginBaseUrl = normalizeOptionalString(
    resolveProviderWebSearchPluginConfig(config, "ollama")?.baseUrl,
  );
  if (pluginBaseUrl) {
    return resolveOllamaApiBase(pluginBaseUrl);
  }
  const configuredBaseUrl = config?.models?.providers?.ollama?.baseUrl;
  if (normalizeOptionalString(configuredBaseUrl)) {
    return resolveOllamaApiBase(configuredBaseUrl);
  }
  return OLLAMA_DEFAULT_BASE_URL;
}

function normalizeOllamaWebSearchResult(
  result: OllamaWebSearchResult,
): { title: string; url: string; content: string } | null {
  const url = normalizeOptionalString(result.url) ?? "";
  if (!url) {
    return null;
  }
  return {
    title: normalizeOptionalString(result.title) ?? "",
    url,
    content: normalizeOptionalString(result.content) ?? "",
  };
}

export async function runOllamaWebSearch(params: {
  config?: OpenClawConfig;
  query: string;
  count?: number;
}): Promise<Record<string, unknown>> {
  const query = params.query.trim();
  if (!query) {
    throw new Error("query parameter is required");
  }

  const baseUrl = resolveOllamaWebSearchBaseUrl(params.config);
  const apiKey = resolveOllamaWebSearchApiKey(params.config);
  const count = resolveSearchCount(params.count, DEFAULT_OLLAMA_WEB_SEARCH_COUNT);
  const startedAt = Date.now();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  const { response, release } = await fetchWithSsrFGuard({
    url: `${baseUrl}${OLLAMA_WEB_SEARCH_PATH}`,
    init: {
      method: "POST",
      headers,
      body: JSON.stringify({ query, max_results: count }),
      signal: AbortSignal.timeout(DEFAULT_OLLAMA_WEB_SEARCH_TIMEOUT_MS),
    },
    policy: buildOllamaBaseUrlSsrFPolicy(baseUrl),
    auditContext: "ollama-web-search.search",
  });

  try {
    if (response.status === 401) {
      throw new Error("Ollama web search authentication failed. Run `ollama signin`.");
    }
    if (response.status === 403) {
      throw new Error(
        "Ollama web search is unavailable. Ensure cloud-backed web search is enabled on the Ollama host.",
      );
    }
    if (!response.ok) {
      const detail = await readResponseText(response, { maxBytes: 64_000 });
      throw new Error(`Ollama web search failed (${response.status}): ${detail.text || ""}`.trim());
    }

    const payload = (await response.json()) as OllamaWebSearchResponse;
    const results = Array.isArray(payload.results)
      ? payload.results
          .map(normalizeOllamaWebSearchResult)
          .filter((result): result is NonNullable<typeof result> => result !== null)
          .slice(0, count)
      : [];

    return {
      query,
      provider: "ollama",
      count: results.length,
      tookMs: Date.now() - startedAt,
      externalContent: {
        untrusted: true,
        source: "web_search",
        provider: "ollama",
        wrapped: true,
      },
      results: results.map((result) => {
        const snippet = truncateText(result.content, OLLAMA_WEB_SEARCH_SNIPPET_MAX_CHARS).text;
        return {
          title: result.title ? wrapWebContent(result.title, "web_search") : "",
          url: result.url,
          snippet: snippet ? wrapWebContent(snippet, "web_search") : "",
          siteName: resolveSiteName(result.url) || undefined,
        };
      }),
    };
  } finally {
    await release();
  }
}

async function warnOllamaWebSearchPrereqs(params: {
  config: OpenClawConfig;
  prompter: {
    note: (message: string, title?: string) => Promise<void>;
  };
}): Promise<OpenClawConfig> {
  const baseUrl = resolveOllamaWebSearchBaseUrl(params.config);
  const { reachable } = await fetchOllamaModels(baseUrl);
  if (!reachable) {
    await params.prompter.note(
      [
        "Ollama Web Search requires Ollama to be running.",
        `Expected host: ${baseUrl}`,
        "Start Ollama before using this provider.",
      ].join("\n"),
      "Ollama Web Search",
    );
    return params.config;
  }

  const auth = await checkOllamaCloudAuth(baseUrl);
  if (!auth.signedIn) {
    await params.prompter.note(
      [
        "Ollama Web Search requires `ollama signin`.",
        ...(auth.signinUrl ? [auth.signinUrl] : ["Run `ollama signin`."]),
      ].join("\n"),
      "Ollama Web Search",
    );
  }

  return params.config;
}

export function createOllamaWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: "ollama",
    label: "Ollama Web Search",
    hint: "Local Ollama host · requires ollama signin",
    onboardingScopes: ["text-inference"],
    requiresCredential: false,
    envVars: [],
    placeholder: "(run ollama signin)",
    signupUrl: "https://ollama.com/",
    docsUrl: "https://docs.openclaw.ai/tools/web",
    autoDetectOrder: 110,
    credentialPath: "",
    getCredentialValue: () => undefined,
    setCredentialValue: () => {},
    applySelectionConfig: (config) => enablePluginInConfig(config, "ollama").config,
    runSetup: async (ctx) =>
      await warnOllamaWebSearchPrereqs({
        config: ctx.config,
        prompter: ctx.prompter,
      }),
    createTool: (ctx) => ({
      description:
        "Search the web using Ollama's web search API. Returns titles, URLs, and snippets from the configured Ollama host.",
      parameters: OLLAMA_WEB_SEARCH_SCHEMA,
      execute: async (args) =>
        await runOllamaWebSearch({
          config: ctx.config,
          query: readStringParam(args, "query", { required: true }),
          count: readNumberParam(args, "count", { integer: true }),
        }),
    }),
  };
}

export const __testing = {
  normalizeOllamaWebSearchResult,
  resolveOllamaWebSearchApiKey,
  resolveOllamaWebSearchBaseUrl,
  warnOllamaWebSearchPrereqs,
};
