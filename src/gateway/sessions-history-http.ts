// Gateway HTTP session history endpoint.
// Serves JSON and SSE history snapshots backed by transcript files.
import type { IncomingMessage, ServerResponse } from "node:http";
import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { getRuntimeConfig } from "../config/io.js";
import { isSessionTranscriptProjectionUnavailableError } from "../config/sessions/session-accessor.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { onInternalSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS } from "./chat-display-projection.js";
import {
  sendInvalidRequest,
  sendJson,
  sendMethodNotAllowed,
  setSseHeaders,
  SSE_CONTENT_TYPE,
} from "./http-common.js";
import { hasExplicitAcceptableMediaRange } from "./http-media-range.js";
import {
  authorizeScopedGatewayHttpRequestOrReply,
  checkGatewayHttpRequestAuth,
  getHeader,
  resolveSharedSecretHttpOperatorScopes,
} from "./http-utils.js";
import { authorizeOperatorScopesForMethod } from "./method-scopes.js";
import {
  buildSessionHistorySnapshot,
  resolveSessionHistoryTailReadOptions,
  SessionHistorySseState,
} from "./session-history-state.js";
import { resolveTranscriptPathForComparison } from "./session-transcript-path.js";
import {
  readRecentSessionMessagesWithStatsAsync,
  readSessionMessagesWithSourceAsync,
} from "./session-transcript-readers.js";
import {
  resolveCanonicalSessionEntryFromStoreKeys,
  resolveGatewaySessionStoreTargetWithStore,
  resolveSessionTranscriptCandidates,
} from "./session-utils.js";

const log = createSubsystemLogger("gateway/sessions-history-sse");

const MAX_SESSION_HISTORY_LIMIT = 1000;

// Route misses must remain distinct from matched-invalid keys so fallback
// stages cannot claim malformed session-history requests.
type SessionHistoryPathResolution =
  | { matched: false }
  | { error: "invalid-session-key"; matched: true }
  | { matched: true; sessionKey: string };

function resolveSessionHistoryPath(req: IncomingMessage): SessionHistoryPathResolution {
  const url = new URL(req.url ?? "/", "http://localhost");
  const match = url.pathname.match(/^\/sessions\/([^/]+)\/history$/);
  if (!match) {
    return { matched: false };
  }
  try {
    const sessionKey = normalizeOptionalString(decodeURIComponent(match[1] ?? ""));
    return sessionKey
      ? { matched: true, sessionKey }
      : { error: "invalid-session-key", matched: true };
  } catch {
    return { error: "invalid-session-key", matched: true };
  }
}

function shouldStreamSse(req: IncomingMessage): boolean {
  return hasExplicitAcceptableMediaRange(getHeader(req, "accept"), SSE_CONTENT_TYPE);
}

function getRequestUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", "http://localhost");
}

function resolveLimit(req: IncomingMessage): Result<number | undefined, string> {
  const raw = getRequestUrl(req).searchParams.get("limit");
  if (raw == null) {
    return ok(undefined);
  }
  const trimmed = raw.trim();
  const value = parseStrictPositiveInteger(trimmed);
  if (value !== undefined) {
    return ok(Math.min(MAX_SESSION_HISTORY_LIMIT, value));
  }
  if (/^\d+$/.test(trimmed) && /[1-9]/.test(trimmed)) {
    return ok(MAX_SESSION_HISTORY_LIMIT);
  }
  return err("limit must be a positive integer");
}

function sseWrite(res: ServerResponse, event: string, payload: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

/** Handle `/sessions/:sessionKey/history` JSON/SSE requests. */
export async function handleSessionHistoryHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: {
    auth: ResolvedGatewayAuth;
    getResolvedAuth?: () => ResolvedGatewayAuth;
    trustedProxies?: string[];
    allowRealIpFallback?: boolean;
    rateLimiter?: AuthRateLimiter;
  },
): Promise<boolean> {
  const sessionKeyResolution = resolveSessionHistoryPath(req);
  if (!sessionKeyResolution.matched) {
    return false;
  }
  if ("error" in sessionKeyResolution) {
    sendInvalidRequest(res, "invalid session key");
    return true;
  }
  const { sessionKey } = sessionKeyResolution;
  if (req.method !== "GET") {
    sendMethodNotAllowed(res, "GET");
    return true;
  }

  // Session history intentionally uses the shared-secret HTTP trust model:
  // token/password bearer auth grants default operator scopes so simple API key
  // callers can read their own history without a scope header.
  const authResult = await authorizeScopedGatewayHttpRequestOrReply({
    req,
    res,
    auth: opts.auth,
    trustedProxies: opts.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback,
    rateLimiter: opts.rateLimiter,
    operatorMethod: "chat.history",
    resolveOperatorScopes: resolveSharedSecretHttpOperatorScopes,
  });
  if (!authResult) {
    return true;
  }
  const { cfg } = authResult;

  let target: ReturnType<typeof resolveGatewaySessionStoreTargetWithStore>;
  let entry: ReturnType<typeof resolveCanonicalSessionEntryFromStoreKeys>;
  try {
    target = resolveGatewaySessionStoreTargetWithStore({ cfg, key: sessionKey });
    entry = resolveCanonicalSessionEntryFromStoreKeys(target.store, target.storeKeys);
  } catch (error) {
    if ((error as { code?: unknown })?.code !== "SESSION_CANONICAL_KEY_MIGRATION_REQUIRED") {
      throw error;
    }
    sendJson(res, 409, {
      ok: false,
      error: {
        type: "migration_required",
        message: error instanceof Error ? error.message : String(error),
      },
    });
    return true;
  }
  if (!entry?.sessionId) {
    sendJson(res, 404, {
      ok: false,
      error: {
        type: "not_found",
        message: `Session not found: ${sessionKey}`,
      },
    });
    return true;
  }
  const limitResult = resolveLimit(req);
  if (!limitResult.ok) {
    sendInvalidRequest(res, limitResult.error);
    return true;
  }
  const limit = limitResult.value;
  const cursor = normalizeOptionalString(getRequestUrl(req).searchParams.get("cursor"));
  const effectiveMaxChars = DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS;
  let boundedSnapshot:
    | Awaited<ReturnType<typeof readRecentSessionMessagesWithStatsAsync>>
    | undefined;
  let fullSnapshot: Awaited<ReturnType<typeof readSessionMessagesWithSourceAsync>> | undefined;
  try {
    boundedSnapshot =
      cursor === undefined && typeof limit === "number"
        ? await readRecentSessionMessagesWithStatsAsync(
            {
              agentId: target.agentId,
              sessionEntry: entry,
              sessionId: entry.sessionId,
              sessionKey: target.canonicalKey,
              storePath: target.storePath,
            },
            {
              ...resolveSessionHistoryTailReadOptions(limit),
              allowResetArchiveFallback: true,
            },
          )
        : undefined;
    // Cursor reads still need an arbitrary historical window. The common first
    // page path is bounded above so `limit=1` cannot materialize huge transcripts.
    fullSnapshot =
      boundedSnapshot === undefined && entry?.sessionId
        ? await readSessionMessagesWithSourceAsync(
            {
              agentId: target.agentId,
              sessionEntry: entry,
              sessionId: entry.sessionId,
              sessionKey: target.canonicalKey,
              storePath: target.storePath,
            },
            {
              mode: "full",
              reason: "session history cursor pagination",
              allowResetArchiveFallback: true,
            },
          )
        : undefined;
  } catch (error) {
    if (!isSessionTranscriptProjectionUnavailableError(error)) {
      throw error;
    }
    res.setHeader("Retry-After", "1");
    sendJson(res, 503, {
      ok: false,
      error: {
        type: "unavailable",
        message: "session history is rebuilding; retry shortly",
        retryable: true,
      },
    });
    return true;
  }
  const rawSnapshot = boundedSnapshot?.messages ?? fullSnapshot?.messages ?? [];
  if (!shouldStreamSse(req)) {
    const history = buildSessionHistorySnapshot({
      rawMessages: rawSnapshot,
      maxChars: effectiveMaxChars,
      limit,
      cursor,
      rawTranscriptSeq: boundedSnapshot?.totalMessages,
      totalRawMessages: boundedSnapshot?.totalMessages,
    }).history;
    sendJson(res, 200, {
      sessionKey: target.canonicalKey,
      ...history,
    });
    return true;
  }

  const transcriptCandidates = entry?.sessionId
    ? new Set(
        resolveSessionTranscriptCandidates(
          entry.sessionId,
          target.storePath,
          undefined,
          target.agentId,
        )
          .map((candidate) => resolveTranscriptPathForComparison(candidate))
          .filter((candidate): candidate is string => typeof candidate === "string"),
      )
    : new Set<string>();

  const sseState = SessionHistorySseState.fromRawSnapshot({
    target: {
      agentId: target.agentId,
      sessionEntry: entry,
      sessionId: entry.sessionId,
      sessionKey: target.canonicalKey,
      storePath: target.storePath,
    },
    rawMessages: rawSnapshot,
    rawTranscriptSeq: boundedSnapshot?.totalMessages,
    totalRawMessages: boundedSnapshot?.totalMessages,
    transcriptPath: boundedSnapshot?.transcriptPath ?? fullSnapshot?.transcriptPath,
    maxChars: effectiveMaxChars,
    limit,
    cursor,
  });
  let sentHistory = sseState.snapshot();
  let streamStopped = false;
  let streamQueue = Promise.resolve();
  const streamResources: {
    heartbeat?: ReturnType<typeof setInterval>;
    unsubscribe?: () => void;
  } = {};

  function writeStreamHistory(snapshot: ReturnType<SessionHistorySseState["snapshot"]>) {
    sseWrite(res, "history", {
      sessionKey: target.canonicalKey,
      ...snapshot,
    });
    // Send the entire requested page before bounding private live state.
    // Cursor refreshes reread SQLite, so their next page remains complete.
    sentHistory = sseState.retainRecentMessages(MAX_SESSION_HISTORY_LIMIT);
  }

  function releaseStreamResources() {
    if (streamStopped) {
      return;
    }
    streamStopped = true;
    if (streamResources.heartbeat) {
      clearInterval(streamResources.heartbeat);
    }
    if (streamResources.unsubscribe) {
      streamResources.unsubscribe();
    }
  }

  function detachStreamListeners() {
    req.off("close", handleRequestStreamClose);
    req.off("error", handleRequestStreamError);
    res.off("close", handleResponseStreamClose);
    res.off("finish", handleResponseStreamFinish);
    res.off("error", handleResponseStreamError);
  }

  function closeStream() {
    releaseStreamResources();
    if (!res.writableEnded && !res.destroyed) {
      res.end();
    }
  }

  function handleRequestStreamClose() {
    releaseStreamResources();
    req.off("close", handleRequestStreamClose);
    req.off("error", handleRequestStreamError);
  }

  function handleRequestStreamError(error: Error) {
    // Node HTTP streams emit process-fatal `error` events without listeners.
    // Request-side failures mean the SSE owner should release and end locally.
    log.warn("session history SSE request stream errored; closing stream", { error });
    closeStream();
  }

  function handleResponseStreamFinish() {
    releaseStreamResources();
    // `finish` only means Node handed the response bytes to the OS. Keep the
    // error listener until `close` so a late flush failure stays stream-local.
    res.off("finish", handleResponseStreamFinish);
  }

  function handleResponseStreamClose() {
    releaseStreamResources();
    detachStreamListeners();
  }

  function handleResponseStreamError(error: Error) {
    // The response stream is already failing, so only release local resources;
    // writing an end frame here can re-enter the errored ServerResponse.
    log.warn("session history SSE response stream errored; cleaning up stream", { error });
    releaseStreamResources();
  }
  const isStreamClosed = () => streamStopped || res.writableEnded || res.destroyed;

  req.on("close", handleRequestStreamClose);
  req.on("error", handleRequestStreamError);
  res.on("close", handleResponseStreamClose);
  res.on("finish", handleResponseStreamFinish);
  res.on("error", handleResponseStreamError);

  setSseHeaders(res);
  res.write("retry: 1000\n\n");
  if (isStreamClosed()) {
    return true;
  }
  writeStreamHistory(sentHistory);
  if (isStreamClosed()) {
    return true;
  }

  const queueStreamWork = (work: () => Promise<void>) => {
    streamQueue = streamQueue
      .then(async () => {
        if (streamStopped || res.writableEnded) {
          return;
        }
        await work();
      })
      .catch((error: unknown) => {
        // Surface the underlying error so operators can distinguish transient
        // infrastructure failures (for example a `getRuntimeConfig()` read error
        // inside the reauth path) from deliberate revocation, then fail closed.
        log.warn("session history SSE stream work failed; closing stream", { error });
        closeStream();
      });
  };

  const isStreamStillAuthorized = async (): Promise<boolean> => {
    const cfgLocal = getRuntimeConfig();
    const currentRequestAuth = await checkGatewayHttpRequestAuth({
      req,
      auth: opts.getResolvedAuth?.() ?? opts.auth,
      trustedProxies: cfgLocal.gateway?.trustedProxies,
      allowRealIpFallback: cfgLocal.gateway?.allowRealIpFallback,
      rateLimiter: opts.rateLimiter,
      cfg: cfgLocal,
    });
    if (!currentRequestAuth.ok) {
      return false;
    }
    const requestedScopes = resolveSharedSecretHttpOperatorScopes(
      req,
      currentRequestAuth.requestAuth,
    );
    return authorizeOperatorScopesForMethod("chat.history", requestedScopes).allowed;
  };

  streamResources.heartbeat = setInterval(() => {
    queueStreamWork(async () => {
      if (!(await isStreamStillAuthorized())) {
        closeStream();
        return;
      }
      if (!res.writableEnded) {
        res.write(": keepalive\n\n");
      }
    });
  }, 15_000);

  streamResources.unsubscribe = onInternalSessionTranscriptUpdate((update) => {
    // Filter to candidate sessions synchronously before enqueueing any async
    // work. Transcript updates use a global fan-out listener, so every
    // transcript write in the gateway would otherwise append a Promise-chain
    // entry capturing `update.message` to every open SSE stream's queue —
    // O(streams × updates) for busy deployments.
    if (!entry?.sessionId) {
      return;
    }
    const updateMatchesIdentity =
      update.target?.sessionId === entry.sessionId &&
      normalizeAgentId(update.target.agentId) === normalizeAgentId(target.agentId);
    const updatePath = resolveTranscriptPathForComparison(update.sessionFile);
    if (!updateMatchesIdentity && (!updatePath || !transcriptCandidates.has(updatePath))) {
      return;
    }
    queueStreamWork(async () => {
      if (res.writableEnded) {
        return;
      }
      if (!(await isStreamStillAuthorized())) {
        closeStream();
        return;
      }
      if (update.message !== undefined) {
        if (limit === undefined && cursor === undefined) {
          if (sseState.shouldRefreshForTranscriptPath(updatePath)) {
            sentHistory = await sseState.refreshAsync();
            writeStreamHistory(sentHistory);
            return;
          }
          const nextEvent = sseState.appendInlineMessage({
            message: update.message,
            messageId: update.messageId,
            messageSeq: update.messageSeq,
          });
          if (!nextEvent) {
            return;
          }
          if (nextEvent.shouldRefresh) {
            sentHistory = await sseState.refreshAsync();
            writeStreamHistory(sentHistory);
            return;
          }
          if (nextEvent.message === undefined) {
            return;
          }
          sentHistory = sseState.retainRecentMessages(MAX_SESSION_HISTORY_LIMIT);
          sseWrite(res, "message", {
            sessionKey: target.canonicalKey,
            message: nextEvent.message,
            ...(typeof update.messageId === "string" ? { messageId: update.messageId } : {}),
            messageSeq: nextEvent.messageSeq,
          });
          return;
        }
      }
      sentHistory = await sseState.refreshAsync();
      writeStreamHistory(sentHistory);
    });
  });
  return true;
}
