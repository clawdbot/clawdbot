/**
 * Z.AI Web Search MCP HTTP runtime. Handles:
 *
 * 1. Credential resolution (config → env var fallback)
 * 2. MCP session initialization (POST initialize → capture Mcp-Session-Id)
 * 3. Tool call (POST tools/call web_search_prime)
 * 4. SSE response parsing with doubly-encoded JSON unwrapping
 * 5. Result mapping, caching, and SSRF safety
 */
import type { SearchConfigRecord } from "openclaw/plugin-sdk/provider-web-search";
import {
  buildSearchCacheKey,
  DEFAULT_SEARCH_COUNT,
  formatCliCommand,
  MAX_SEARCH_COUNT,
  readCachedSearchPayload,
  readConfiguredSecretString,
  readPositiveIntegerParam,
  readProviderEnvValue,
  readStringParam,
  resolveSearchCacheTtlMs,
  resolveSearchCount,
  resolveSearchTimeoutSeconds,
  resolveSiteName,
  wrapWebContent,
  writeCachedSearchPayload,
} from "openclaw/plugin-sdk/provider-web-search";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { ZAI_CREDENTIAL_PATH } from "../web-search-shared.js";

const ZAI_MCP_DEFAULT_URL = "https://api.z.ai/api/mcp/web_search_prime/mcp";
const zaiSearchLogger = createSubsystemLogger("zai-search");

//#region Config resolution

function resolveZaiApiKey(
  searchConfig?: SearchConfigRecord,
): string | undefined {
  return (
    readConfiguredSecretString(searchConfig?.apiKey, ZAI_CREDENTIAL_PATH) ??
    readProviderEnvValue(["ZAI_API_KEY", "Z_AI_API_KEY"])
  );
}

function resolveZaiBaseUrl(searchConfig?: SearchConfigRecord): string {
  const configured = readConfiguredSecretString(
    searchConfig?.baseUrl,
    "plugins.entries.zai-search.config.webSearch.baseUrl",
  );
  return configured?.replace(/\/+$/u, "") || ZAI_MCP_DEFAULT_URL;
}

//#endregion

//#region MCP protocol helpers

/** Parse SSE response text, returning the last JSON-RPC data payload. */
function parseMcpSseResponse(text: string): Record<string, unknown> | null {
  const lines = text.split("\n");
  let lastData: Record<string, unknown> | null = null;
  for (const line of lines) {
    if (line.startsWith("data:")) {
      const jsonStr = line.slice(5).trim();
      try {
        lastData = JSON.parse(jsonStr) as Record<string, unknown>;
      } catch {
        // skip non-JSON lines
      }
    }
  }
  return lastData;
}

type ZaiSearchResult = {
  title?: string;
  link?: string;
  url?: string;
  content?: string;
  snippet?: string;
  refer?: string;
};

/**
 * Extract search results from an MCP tool-call response.
 *
 * The MCP `text` field contains a JSON-encoded string which itself wraps a
 * JSON array — i.e. doubly escaped. We parse up to twice to unwrap both
 * layers.
 */
function extractSearchResults(
  mcpResult: Record<string, unknown> | null,
): Array<{
  title: string;
  url: string;
  description: string;
  siteName: string | undefined;
}> {
  const result = mcpResult?.result as Record<string, unknown> | undefined;
  const content = result?.content;
  if (!Array.isArray(content)) return [];

  for (const item of content) {
    if (
      typeof item !== "object" ||
      item === null ||
      (item as { type?: string }).type !== "text"
    ) {
      continue;
    }
    const text = (item as { text?: unknown }).text;
    if (typeof text !== "string") continue;

    let parsed: unknown = text;
    // May need up to 2 JSON.parse calls to unwrap the double encoding.
    for (let depth = 0; depth < 2; depth++) {
      if (typeof parsed !== "string") break;
      try {
        parsed = JSON.parse(parsed);
      } catch {
        break;
      }
    }

    if (Array.isArray(parsed)) {
      return parsed
        .filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null)
        .map((r) => {
          const entry = r as ZaiSearchResult;
          const url = entry.link || entry.url || "";
          return {
            title: entry.title || "",
            url,
            description: entry.content || entry.snippet || "",
            siteName: resolveSiteName(url) || undefined,
          };
        });
    }
  }
  return [];
}

/** Map shared freshness values to Z.AI recency filter values. */
function resolveRecencyFilter(
  args: Record<string, unknown>,
): string | undefined {
  const freshness = args.freshness;
  if (typeof freshness !== "string") return undefined;
  const map: Record<string, string> = {
    day: "oneDay",
    week: "oneWeek",
    month: "oneMonth",
    year: "oneYear",
  };
  return map[freshness] ?? undefined;
}

/** Map country code to Z.AI location. */
function resolveLocation(country: string | undefined): string | undefined {
  if (!country) return undefined;
  if (country.toUpperCase() === "CN") return "cn";
  return "us";
}

//#endregion

//#region Search execution

/**
 * Execute Z.AI web search via the MCP protocol:
 * 1. Initialize session → capture Mcp-Session-Id
 * 2. Call web_search_prime tool
 */
export async function executeZaiSearch(
  args: Record<string, unknown>,
  searchConfig: SearchConfigRecord | undefined,
  options: { signal?: AbortSignal },
): Promise<Record<string, unknown>> {
  const apiKey = resolveZaiApiKey(searchConfig);
  if (!apiKey) {
    return {
      error: "missing_zai_api_key",
      message: `web_search (zai-search) needs a Z.AI API key. Run \`${formatCliCommand("openclaw configure --section web")}\` to store it, or set ZAI_API_KEY in the Gateway environment.`,
      docs: "https://docs.z.ai/api-reference/tools/web-search",
    };
  }

  const baseUrl = resolveZaiBaseUrl(searchConfig);
  const query = readStringParam(args, "query", { required: true });
  if (!query) {
    return {
      error: "missing_query",
      message: "query is required for web search.",
    };
  }

  const count = readPositiveIntegerParam(args, "count", {
    max: MAX_SEARCH_COUNT,
    message: `count must be an integer from 1 to ${MAX_SEARCH_COUNT}.`,
  });
  const resolvedCount = resolveSearchCount(count, DEFAULT_SEARCH_COUNT);
  const country = readStringParam(args, "country");
  const location = resolveLocation(country) ?? "us";
  const recency = resolveRecencyFilter(args);
  const contentSize = resolvedCount <= 3 ? "medium" : "high";
  const timeoutSeconds = resolveSearchTimeoutSeconds(searchConfig);
  const cacheTtlMs = resolveSearchCacheTtlMs(searchConfig);

  // Build cache key
  const cacheKey = buildSearchCacheKey([
    "zai-search",
    baseUrl,
    query,
    resolvedCount,
    location,
    recency,
    contentSize,
  ]);
  const cached = readCachedSearchPayload(cacheKey);
  if (cached) return cached;

  const start = Date.now();

  // Build MCP search arguments
  const searchArgs: Record<string, unknown> = {
    search_query: query,
    location,
    content_size: contentSize,
  };
  if (recency) searchArgs.search_recency_filter = recency;

  try {
    // Step 1: Initialize MCP session
    const initResponse = await fetch(baseUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "openclaw-zai-search", version: "0.1.0" },
        },
        id: 1,
      }),
      signal: options.signal ?? AbortSignal.timeout(timeoutSeconds * 1000),
    });

    if (!initResponse.ok) {
      const errBody = await initResponse.text().catch(() => "");
      zaiSearchLogger.error(
        `MCP initialize failed: ${initResponse.status} ${errBody.slice(0, 200)}`,
      );
      return {
        error: "zai_mcp_init_failed",
        message: `Z.AI MCP initialize failed (HTTP ${initResponse.status}). ${errBody.slice(0, 300)}`,
      };
    }

    const sessionId = initResponse.headers.get("mcp-session-id");
    if (!sessionId) {
      zaiSearchLogger.error("MCP did not return session ID");
      return {
        error: "zai_mcp_no_session",
        message: "Z.AI MCP did not return a session ID.",
      };
    }

    // Step 2: Call web_search_prime tool
    const callResponse = await fetch(baseUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "Mcp-Session-Id": sessionId,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "web_search_prime",
          arguments: searchArgs,
        },
        id: 2,
      }),
      signal: options.signal ?? AbortSignal.timeout(timeoutSeconds * 1000),
    });

    if (!callResponse.ok) {
      const errBody = await callResponse.text().catch(() => "");
      zaiSearchLogger.error(`MCP search call failed: ${callResponse.status}`);
      return {
        error: "zai_mcp_call_failed",
        message: `Z.AI MCP search call failed (HTTP ${callResponse.status}). ${errBody.slice(0, 300)}`,
      };
    }

    const responseText = await callResponse.text();
    const mcpResult = parseMcpSseResponse(responseText);

    if (mcpResult?.error) {
      zaiSearchLogger.error(
        `MCP RPC error: ${JSON.stringify(mcpResult.error)}`,
      );
      return {
        error: "zai_search_rpc_error",
        message: `Z.AI search RPC error: ${(mcpResult.error as { message?: string })?.message || JSON.stringify(mcpResult.error)}`,
      };
    }

    const result = mcpResult?.result as Record<string, unknown> | undefined;
    if (result?.isError) {
      const content = result.content;
      const errorText =
        (Array.isArray(content) && content[0] && typeof content[0] === "object" &&
          (content[0] as { text?: string }).text) ||
        "Unknown error";
      return {
        error: "zai_search_error",
        message: `Z.AI search error: ${errorText}`,
      };
    }

    const results = extractSearchResults(mcpResult).slice(0, resolvedCount);

    const payload = {
      query,
      provider: "zai-search",
      count: results.length,
      tookMs: Date.now() - start,
      externalContent: {
        untrusted: true,
        source: "web_search",
        provider: "zai-search",
        wrapped: true,
      },
      results: results.map((entry) => ({
        title: entry.title ? wrapWebContent(entry.title, "web_search") : "",
        url: entry.url,
        description: entry.description
          ? wrapWebContent(entry.description, "web_search")
          : "",
        siteName: entry.siteName,
      })),
    };

    writeCachedSearchPayload(cacheKey, payload, cacheTtlMs);
    return payload;
  } catch (err) {
    const msg = (err as Error)?.message || String(err);
    zaiSearchLogger.error(`zai-search failed: ${msg}`);
    return {
      error: "zai_search_exception",
      message: `Z.AI web search failed: ${msg}`,
    };
  }
}

//#endregion
