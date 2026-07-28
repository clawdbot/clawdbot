// Senseaudio provider module implements model/runtime integration.
import {
  createProviderHttpError,
  readProviderJsonObjectResponse,
} from "openclaw/plugin-sdk/provider-http";
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-onboard";
import {
  buildSearchCacheKey,
  buildUnsupportedSearchFilterResponse,
  formatCliCommand,
  mergeScopedSearchConfig,
  readCachedSearchPayload,
  readConfiguredSecretString,
  readProviderEnvValue,
  readStringParam,
  resolveProviderWebSearchPluginConfig,
  resolveSearchCacheTtlMs,
  resolveSearchTimeoutSeconds,
  withSelfHostedWebSearchEndpoint,
  withTrustedWebSearchEndpoint,
  wrapWebContent,
  writeCachedSearchPayload,
  type SearchConfigRecord,
} from "openclaw/plugin-sdk/provider-web-search";
import {
  assertHttpUrlTargetsPrivateNetwork,
  isBlockedHostnameOrIp,
  isPrivateIpAddress,
  resolvePinnedHostnameWithPolicy,
  type LookupFn,
} from "openclaw/plugin-sdk/ssrf-runtime";
import {
  isRecord,
  normalizeOptionalString,
  uniqueStrings,
} from "openclaw/plugin-sdk/string-coerce-runtime";

const DEFAULT_SENSEAUDIO_BASE_URL = "https://api.senseaudio.cn/v1";
const DEFAULT_SENSEAUDIO_SEARCH_MODEL = "senseaudio-s2";

type SenseAudioConfig = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
};

type SenseAudioOutputItem = {
  type?: string;
  status?: string;
  content?: Array<{
    type?: string;
    text?: string;
    annotations?: Array<{ type?: string; url?: string }>;
  }>;
  action?: {
    sources?: Array<{ url?: string }>;
  };
};

type SenseAudioResponse = {
  status?: string;
  error?: { message?: string } | null;
  incomplete_details?: { reason?: string } | null;
  output?: SenseAudioOutputItem[];
};

type SenseAudioSearchResult = {
  content: string;
  citations: string[];
  grounded: boolean;
};

function throwMalformedSenseAudioResponse(): never {
  throw new Error("SenseAudio API error: malformed JSON response");
}

function resolveSenseAudioConfig(searchConfig?: SearchConfigRecord): SenseAudioConfig {
  const senseaudio = searchConfig?.senseaudio;
  return isRecord(senseaudio) ? (senseaudio as SenseAudioConfig) : {};
}

function resolveSenseAudioApiKey(senseaudio?: SenseAudioConfig): string | undefined {
  return (
    readConfiguredSecretString(senseaudio?.apiKey, "tools.web.search.senseaudio.apiKey") ??
    readProviderEnvValue(["SENSEAUDIO_API_KEY"])
  );
}

function resolveSenseAudioModel(senseaudio?: SenseAudioConfig): string {
  return normalizeOptionalString(senseaudio?.model) ?? DEFAULT_SENSEAUDIO_SEARCH_MODEL;
}

function resolveSenseAudioBaseUrl(senseaudio?: SenseAudioConfig): string {
  const explicit = (normalizeOptionalString(senseaudio?.baseUrl) ?? "").replace(/\/+$/, "");
  return explicit || DEFAULT_SENSEAUDIO_BASE_URL;
}

type SenseAudioEndpointMode = "selfHosted" | "strict";

async function senseaudioEndpointTargetsPrivateNetwork(
  url: URL,
  lookupFn?: LookupFn,
): Promise<boolean> {
  if (isBlockedHostnameOrIp(url.hostname)) {
    return true;
  }
  try {
    const pinned = await resolvePinnedHostnameWithPolicy(url.hostname, {
      lookupFn,
      policy: {
        allowPrivateNetwork: true,
        allowRfc2544BenchmarkRange: true,
      },
    });
    return pinned.addresses.every((address) => isPrivateIpAddress(address));
  } catch {
    return false;
  }
}

/** Explicitly configured private/loopback endpoints are operator opt-in and use
 * the self-hosted network policy; the default endpoint and public overrides
 * keep the strict trusted policy (same contract as SearXNG). */
async function resolveSenseAudioEndpointMode(
  baseUrl: string,
  lookupFn?: LookupFn,
): Promise<SenseAudioEndpointMode> {
  if (baseUrl === DEFAULT_SENSEAUDIO_BASE_URL) {
    return "strict";
  }
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("SenseAudio base URL must be a valid http:// or https:// URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("SenseAudio base URL must use http:// or https://.");
  }
  if (parsed.protocol === "http:") {
    // Cleartext would expose the API key, so http is private/loopback-only.
    await assertHttpUrlTargetsPrivateNetwork(parsed.toString(), {
      dangerouslyAllowPrivateNetwork: true,
      lookupFn,
      errorMessage:
        "SenseAudio HTTP base URL must target a trusted private or loopback host. Use https:// for public hosts.",
    });
    return "selfHosted";
  }
  return (await senseaudioEndpointTargetsPrivateNetwork(parsed, lookupFn))
    ? "selfHosted"
    : "strict";
}

function extractSenseAudioMessageText(items: SenseAudioOutputItem[]): string | undefined {
  const parts: string[] = [];
  for (const item of items) {
    if (item.type !== "message" || !Array.isArray(item.content)) {
      continue;
    }
    for (const part of item.content) {
      if (isRecord(part) && part.type === "output_text" && typeof part.text === "string") {
        const text = part.text.trim();
        if (text) {
          parts.push(text);
        }
      }
    }
  }
  const joined = parts.join("\n\n").trim();
  return joined || undefined;
}

function extractSenseAudioCitations(items: SenseAudioOutputItem[]): string[] {
  const citations: string[] = [];
  for (const item of items) {
    if (item.type === "web_search_call") {
      // One response can carry multiple web_search_call items; sources only
      // appear when the request includes web_search_call.action.sources.
      const sources =
        isRecord(item.action) && Array.isArray(item.action.sources) ? item.action.sources : [];
      for (const source of sources) {
        const url = isRecord(source) ? normalizeOptionalString(source.url) : undefined;
        if (url) {
          citations.push(url);
        }
      }
      continue;
    }
    if (item.type !== "message" || !Array.isArray(item.content)) {
      continue;
    }
    for (const part of item.content) {
      if (!isRecord(part) || !Array.isArray(part.annotations)) {
        continue;
      }
      for (const annotation of part.annotations) {
        if (isRecord(annotation) && annotation.type === "url_citation") {
          const url = normalizeOptionalString(annotation.url);
          if (url) {
            citations.push(url);
          }
        }
      }
    }
  }
  return uniqueStrings(citations);
}

function parseSenseAudioSearchResponse(data: SenseAudioResponse): SenseAudioSearchResult {
  if (data.error != null) {
    const message = isRecord(data.error) ? normalizeOptionalString(data.error.message) : undefined;
    throw new Error(`SenseAudio API error: ${message ?? "unknown error"}`);
  }
  const status = normalizeOptionalString(data.status);
  if (status && status !== "completed") {
    const reason = isRecord(data.incomplete_details)
      ? normalizeOptionalString(data.incomplete_details.reason)
      : undefined;
    throw new Error(
      `SenseAudio API error: response status "${status}"${reason ? ` (${reason})` : ""}`,
    );
  }
  if (!Array.isArray(data.output)) {
    throwMalformedSenseAudioResponse();
  }
  const items = data.output.filter(isRecord) as SenseAudioOutputItem[];
  const content = extractSenseAudioMessageText(items);
  if (!content) {
    throwMalformedSenseAudioResponse();
  }
  const citations = extractSenseAudioCitations(items);
  // Grounding needs a completed search call or concrete citations; tool_choice
  // forces a web_search_call item into every reply, so presence alone would
  // also count failed/aborted searches as grounded.
  const hasCompletedSearchCall = items.some(
    (item) =>
      item.type === "web_search_call" && (item.status === undefined || item.status === "completed"),
  );
  return {
    content,
    citations,
    grounded: hasCompletedSearchCall || citations.length > 0,
  };
}

async function runSenseAudioSearch(params: {
  query: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutSeconds: number;
  endpointMode: SenseAudioEndpointMode;
  signal?: AbortSignal;
}): Promise<SenseAudioSearchResult> {
  const endpoint = `${params.baseUrl}/responses`;
  const withEndpoint =
    params.endpointMode === "selfHosted"
      ? withSelfHostedWebSearchEndpoint
      : withTrustedWebSearchEndpoint;
  return await withEndpoint(
    {
      url: endpoint,
      timeoutSeconds: params.timeoutSeconds,
      signal: params.signal,
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${params.apiKey}`,
        },
        body: JSON.stringify({
          model: params.model,
          input: [{ type: "message", role: "user", content: params.query }],
          tools: [{ type: "web_search" }],
          // Forced tool_choice guarantees grounded answers instead of chat-only replies.
          tool_choice: { type: "web_search" },
          // Source URLs are omitted from web_search_call items unless included.
          include: ["web_search_call.action.sources"],
          store: false,
          stream: false,
        }),
      },
    },
    async (res) => {
      if (!res.ok) {
        throw await createProviderHttpError(res, "SenseAudio API error");
      }
      const data = (await readProviderJsonObjectResponse(
        res,
        "SenseAudio API error",
      )) as SenseAudioResponse;
      return parseSenseAudioSearchResponse(data);
    },
  );
}

export async function executeSenseAudioWebSearchProviderTool(
  ctx: { config?: OpenClawConfig; searchConfig?: SearchConfigRecord },
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const searchConfig = mergeScopedSearchConfig(
    ctx.searchConfig,
    "senseaudio",
    resolveProviderWebSearchPluginConfig(ctx.config, "senseaudio"),
  );
  const unsupportedResponse = buildUnsupportedSearchFilterResponse(args, "senseaudio");
  if (unsupportedResponse) {
    return unsupportedResponse;
  }

  const senseaudioConfig = resolveSenseAudioConfig(searchConfig);
  const apiKey = resolveSenseAudioApiKey(senseaudioConfig);
  if (!apiKey) {
    return {
      error: "missing_senseaudio_api_key",
      message: `web_search (senseaudio) needs a SenseAudio API key. Run \`${formatCliCommand("openclaw configure --section web")}\` to store it, or set SENSEAUDIO_API_KEY in the Gateway environment. If you do not want to configure a search API key, use web_fetch for a specific URL or the browser tool for interactive pages.`,
      docs: "https://docs.openclaw.ai/tools/web",
    };
  }

  const query = readStringParam(args, "query", { required: true });
  const model = resolveSenseAudioModel(senseaudioConfig);
  const baseUrl = resolveSenseAudioBaseUrl(senseaudioConfig);
  const cacheKey = buildSearchCacheKey(["senseaudio", query, baseUrl, model]);
  const cached = readCachedSearchPayload(cacheKey);
  if (cached) {
    return cached;
  }

  const start = Date.now();
  const endpointMode = await resolveSenseAudioEndpointMode(baseUrl);
  const result = await runSenseAudioSearch({
    query,
    apiKey,
    baseUrl,
    model,
    timeoutSeconds: resolveSearchTimeoutSeconds(searchConfig),
    endpointMode,
    signal,
  });
  if (!result.grounded) {
    return {
      error: "senseaudio_web_search_ungrounded",
      message:
        "SenseAudio returned a completion without native web-search grounding. Retry the query, switch to a structured provider such as Brave, or use web_fetch/browser for a specific URL.",
      query,
      provider: "senseaudio",
      model,
      docs: "https://docs.openclaw.ai/tools/senseaudio-search",
      tookMs: Date.now() - start,
    };
  }
  const payload = {
    query,
    provider: "senseaudio",
    model,
    tookMs: Date.now() - start,
    externalContent: {
      untrusted: true,
      source: "web_search",
      provider: "senseaudio",
      wrapped: true,
    },
    content: wrapWebContent(result.content),
    citations: result.citations,
  };
  writeCachedSearchPayload(cacheKey, payload, resolveSearchCacheTtlMs(searchConfig));
  return payload;
}

export const testing = {
  resolveSenseAudioApiKey,
  resolveSenseAudioModel,
  resolveSenseAudioBaseUrl,
  resolveSenseAudioEndpointMode,
  parseSenseAudioSearchResponse,
} as const;
export { testing as __testing };
