import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { readPluginPackageVersion } from "openclaw/plugin-sdk/extension-shared";
import {
  readProviderTextResponse,
  readResponseTextLimited,
} from "openclaw/plugin-sdk/provider-http";
import { withTrustedWebSearchEndpoint } from "openclaw/plugin-sdk/provider-web-search";

// Free hosted Search MCP. This keyless transport is used only after the user
// explicitly selects the `parallel-free` web_search provider. Docs:
// https://docs.parallel.ai/integrations/mcp/search-mcp
export const PARALLEL_MCP_SEARCH_URL = "https://search.parallel.ai/mcp";
// Initial protocol version we advertise on `initialize`; we then echo whatever
// the server negotiates back on every follow-up request.
const MCP_PROTOCOL_VERSION = "2025-06-18";
const MCP_TIMEOUT_SECONDS = 30;
const PARALLEL_MCP_ERROR_BODY_LIMIT_BYTES = 8 * 1024;

const require = createRequire(import.meta.url);
const PLUGIN_VERSION = readPluginPackageVersion({ require });
// Identify free-tier traffic at the HTTP layer (mirrors the paid REST path);
// without this, undici sends a generic `node` UA and OpenClaw usage is only
// visible via the JSON-RPC `clientInfo` payload.
const USER_AGENT = `openclaw-parallel/${PLUGIN_VERSION} (${process.platform})`;

type JsonRpcMessage = Record<string, unknown>;

type McpToolPayload = Record<string, unknown>;

/** ParallelSearchResponse-compatible shape consumed by the runtime normalizer. */
export type ParallelMcpSearchResponse = {
  search_id?: unknown;
  session_id?: unknown;
  results: unknown[];
  warnings?: unknown;
  usage?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mcpHeaders(params: {
  sessionId?: string;
  protocolVersion?: string;
}): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
    // The Search MCP may answer either as a single JSON object or as an SSE
    // stream; advertise both so the server can pick.
    Accept: "application/json, text/event-stream",
  };
  // After `initialize` the Streamable-HTTP spec expects the negotiated session
  // id and protocol version echoed on every follow-up request.
  if (params.sessionId) {
    headers["Mcp-Session-Id"] = params.sessionId;
  }
  if (params.protocolVersion) {
    headers["MCP-Protocol-Version"] = params.protocolVersion;
  }
  // No Authorization header: the free tier is anonymous, and sending an
  // empty/garbage bearer would flip the server to a 401 instead of serving it.
  return headers;
}

/**
 * Yield JSON-RPC message objects from a plain-JSON or SSE response body.
 *
 * Handles `application/json` (a single object) and `text/event-stream` (SSE:
 * events separated by blank lines; an event's one-or-more `data:` lines
 * concatenate into a single JSON payload). Streamable HTTP also allows batching
 * responses into a JSON array, so arrays are flattened. Unparseable chunks and
 * non-`data` SSE fields (`event:`/`id:`/comments) are skipped.
 */
export function iterMcpMessages(text: string): JsonRpcMessage[] {
  const out: JsonRpcMessage[] = [];
  const emit = (payload: unknown): void => {
    if (Array.isArray(payload)) {
      for (const entry of payload) {
        if (isRecord(entry)) {
          out.push(entry);
        }
      }
    } else if (isRecord(payload)) {
      out.push(payload);
    }
  };

  const body = (text ?? "").trim();
  if (!body) {
    return out;
  }
  if (body.startsWith("{") || body.startsWith("[")) {
    try {
      emit(JSON.parse(body));
    } catch {
      // Non-JSON body: nothing to emit.
    }
    return out;
  }

  let dataLines: string[] = [];
  const flush = (): void => {
    if (dataLines.length === 0) {
      return;
    }
    try {
      emit(JSON.parse(dataLines.join("\n")));
    } catch {
      // Skip an unparseable SSE event rather than failing the whole stream.
    }
    dataLines = [];
  };

  for (const raw of body.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).replace(/^ /, ""));
    } else if (line.trim() === "") {
      flush();
    }
  }
  flush();
  return out;
}

/**
 * Select the JSON-RPC response for `requestId` from an MCP response body.
 *
 * Streamable-HTTP servers may emit progress/log notifications before the final
 * result, so scan the whole stream and return the result/error message whose
 * `id` matches. Falls back to the last result/error-bearing message if no id
 * matches; `{}` if none is present.
 */
export function selectMcpEnvelope(text: string, requestId: string): JsonRpcMessage {
  let fallback: JsonRpcMessage = {};
  for (const msg of iterMcpMessages(text)) {
    if (!("result" in msg || "error" in msg)) {
      continue;
    }
    if (msg.id === requestId) {
      return msg;
    }
    fallback = msg;
  }
  return fallback;
}

/**
 * Extract the tool result payload from a `tools/call` envelope.
 *
 * Prefers `structuredContent` (authoritative machine-readable form); otherwise
 * scans text blocks for the first JSON-parseable one. Throws on a JSON-RPC
 * error or a tool-level `isError`.
 */
export function extractMcpToolPayload(envelope: JsonRpcMessage): McpToolPayload {
  if ("error" in envelope) {
    throw new Error(`Parallel MCP error: ${JSON.stringify(envelope.error).slice(0, 500)}`);
  }
  const result = isRecord(envelope.result) ? envelope.result : {};
  if (result.isError) {
    throw new Error(`Parallel MCP tool error: ${JSON.stringify(result).slice(0, 500)}`);
  }
  if (isRecord(result.structuredContent)) {
    return result.structuredContent;
  }
  const content = Array.isArray(result.content) ? result.content : [];
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string" && block.text) {
      try {
        const parsed: unknown = JSON.parse(block.text);
        if (isRecord(parsed)) {
          return parsed;
        }
      } catch {
        // Try the next text block.
      }
    }
  }
  throw new Error(
    `Parallel MCP returned no parseable content: ${JSON.stringify(result).slice(0, 500)}`,
  );
}

type McpHttpResult = {
  ok: boolean;
  status: number;
  statusText: string;
  text: string;
  sessionIdHeader: string | null;
};

async function postMcp(params: {
  body: JsonRpcMessage;
  sessionId?: string;
  protocolVersion?: string;
  timeoutSeconds: number;
  signal?: AbortSignal;
}): Promise<McpHttpResult> {
  return withTrustedWebSearchEndpoint(
    {
      url: PARALLEL_MCP_SEARCH_URL,
      timeoutSeconds: params.timeoutSeconds,
      signal: params.signal,
      init: {
        method: "POST",
        headers: mcpHeaders({
          sessionId: params.sessionId,
          protocolVersion: params.protocolVersion,
        }),
        body: JSON.stringify(params.body),
      },
    },
    // Read the body inside the callback: the trusted-endpoint wrapper ties the
    // request's abort/timeout lifecycle to this scope (same pattern as the REST
    // path), so the Response must be consumed here, not returned and read later.
    async (response) => ({
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      text: response.ok
        ? await readProviderTextResponse(response, "Parallel MCP")
        : await readResponseTextLimited(response, PARALLEL_MCP_ERROR_BODY_LIMIT_BYTES),
      sessionIdHeader: response.headers.get("mcp-session-id"),
    }),
  );
}

/**
 * Run the MCP handshake then a single `tools/call`, returning the tool payload.
 *
 * initialize -> (capture `Mcp-Session-Id` header + negotiated protocolVersion)
 * -> notifications/initialized -> tools/call. Anonymous (no bearer token).
 */
async function mcpCall(
  toolName: string,
  args: Record<string, unknown>,
  timeoutSeconds: number,
  signal?: AbortSignal,
): Promise<McpToolPayload> {
  // 1. initialize — capture the server-assigned session id + negotiated version.
  const initId = randomUUID();
  const init = await postMcp({
    timeoutSeconds,
    signal,
    body: {
      jsonrpc: "2.0",
      id: initId,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "openclaw-parallel", version: PLUGIN_VERSION },
      },
    },
  });
  if (!init.ok) {
    throw new Error(
      `Parallel MCP initialize failed (${init.status}): ${init.text || init.statusText}`,
    );
  }
  // Only echo a server-assigned session id. Stateless Streamable HTTP servers
  // omit Mcp-Session-Id; inventing one can make such servers reject follow-ups.
  const sessionId = init.sessionIdHeader ?? undefined;
  const initEnvelope = selectMcpEnvelope(init.text, initId);
  const negotiatedVersion =
    (isRecord(initEnvelope.result) && typeof initEnvelope.result.protocolVersion === "string"
      ? initEnvelope.result.protocolVersion
      : undefined) ?? MCP_PROTOCOL_VERSION;

  // 2. notifications/initialized — required handshake ack (no response body).
  await postMcp({
    body: { jsonrpc: "2.0", method: "notifications/initialized" },
    sessionId,
    protocolVersion: negotiatedVersion,
    timeoutSeconds,
    signal,
  });

  // 3. tools/call.
  const callId = randomUUID();
  const call = await postMcp({
    body: {
      jsonrpc: "2.0",
      id: callId,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    },
    sessionId,
    protocolVersion: negotiatedVersion,
    timeoutSeconds,
    signal,
  });
  if (!call.ok) {
    throw new Error(
      `Parallel MCP tools/call failed (${call.status}): ${call.text || call.statusText}`,
    );
  }
  return extractMcpToolPayload(selectMcpEnvelope(call.text, callId));
}

function normalizeMcpSessionId(value: string | undefined): string {
  // Use the caller-supplied id verbatim — the runtime already applies the
  // shared session-id contract before building the cache key, so reusing it
  // here keeps the MCP session, cache key, and reported sessionId in agreement
  // (re-minting a valid id would silently break session grouping). The Search
  // MCP requires a session_id, so mint a per-call uuid only when none was given.
  return value?.trim() || randomUUID();
}

/**
 * Run a `web_search` tool call against the free hosted Search MCP and return a
 * `ParallelSearchResponse`-compatible object so the runtime's existing result
 * normalization (`normalizeParallelResults`) is reused verbatim.
 */
export async function runParallelMcpSearch(params: {
  objective?: string;
  searchQueries: readonly string[];
  maxResults: number;
  sessionId?: string;
  modelName?: string;
  timeoutSeconds?: number;
  signal?: AbortSignal;
}): Promise<ParallelMcpSearchResponse> {
  const sessionId = normalizeMcpSessionId(params.sessionId);
  const args: Record<string, unknown> = {
    // MCP requires a non-empty objective (REST treats it as optional); when the
    // caller only supplied keyword queries, use them as the objective rather
    // than failing the call.
    objective: params.objective ?? params.searchQueries.join(" "),
    search_queries: [...params.searchQueries],
    session_id: sessionId,
  };
  if (params.modelName) {
    args.model_name = params.modelName;
  }

  const payload = await mcpCall(
    "web_search",
    args,
    params.timeoutSeconds ?? MCP_TIMEOUT_SECONDS,
    params.signal,
  );
  const allResults = Array.isArray(payload.results) ? payload.results : [];
  // The MCP serves a fixed result count, so apply the caller's count client-side
  // to match the REST path's max_results behavior.
  const results = allResults.slice(0, Math.max(params.maxResults, 1));

  return {
    search_id: typeof payload.search_id === "string" ? payload.search_id : undefined,
    session_id: sessionId,
    results,
    warnings: payload.warnings,
    usage: payload.usage,
  };
}
