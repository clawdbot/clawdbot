import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { getRuntimeConfig } from "../config/io.js";
import { loadSessionStore } from "../config/sessions.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { onSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import {
  sendInvalidRequest,
  sendJson,
  sendMethodNotAllowed,
  setSseHeaders,
} from "./http-common.js";
import {
  authorizeScopedGatewayHttpRequestOrReply,
  checkGatewayHttpRequestAuth,
  getHeader,
  resolveTrustedHttpOperatorScopes,
} from "./http-utils.js";
import { authorizeOperatorScopesForMethod } from "./method-scopes.js";
import { DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS } from "./server-methods/chat.js";
import {
  buildSessionHistorySnapshot,
  resolveSessionHistoryTailReadOptions,
  SessionHistorySseState,
} from "./session-history-state.js";
import {
  readRecentSessionMessagesWithStatsAsync,
  readSessionMessagesAsync,
  resolveFreshestSessionEntryFromStoreKeys,
  resolveGatewaySessionStoreTarget,
  resolveSessionTranscriptCandidates,
} from "./session-utils.js";

const log = createSubsystemLogger("gateway/sessions-history-sse");

const MAX_SESSION_HISTORY_LIMIT = 1000;

function resolveSessionHistoryPath(req: IncomingMessage): string | null {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const match = url.pathname.match(/^\/sessions\/([^/]+)\/history$/);
  if (!match) {
    return null;
  }
  try {
    return normalizeOptionalString(decodeURIComponent(match[1] ?? "")) ?? null;
  } catch {
    return "";
  }
}

function shouldStreamSse(req: IncomingMessage): boolean {
  const accept = normalizeLowercaseStringOrEmpty(getHeader(req, "accept"));
  return accept.includes("text/event-stream");
}

function getRequestUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
}

function resolveLimit(req: IncomingMessage): number | undefined {
  const raw = getRequestUrl(req).searchParams.get("limit");
  if (raw == null || raw.trim() === "") {
    return undefined;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 1) {
    return 1;
  }
  return Math.min(MAX_SESSION_HISTORY_LIMIT, Math.max(1, value));
}

function canonicalizePath(value: string | undefined): string | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  const resolved = path.resolve(trimmed);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function sseWrite(res: ServerResponse, event: string, payload: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

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
  const sessionKey = resolveSessionHistoryPath(req);
  if (sessionKey === null) {
    return false;
  }
  if (!sessionKey) {
    sendInvalidRequest(res, "invalid session key");
    return true;
  }
  if (req.method !== "GET") {
    sendMethodNotAllowed(res, "GET");
    return true;
  }

  // HTTP callers must declare the same least-privilege operator scopes they
  // intend to use over WS so both transport surfaces enforce the same gate.
  const authResult = await authorizeScopedGatewayHttpRequestOrReply({
    req,
    res,
    auth: opts.auth,
    trustedProxies: opts.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback,
    rateLimiter: opts.rateLimiter,
    operatorMethod: "chat.history",
    resolveOperatorScopes: resolveTrustedHttpOperatorScopes,
  });
  if (!authResult) {
    return true;
  }
  const { cfg } = authResult;

  const target = resolveGatewaySessionStoreTarget({ cfg, key: sessionKey });
  const store = loadSessionStore(target.storePath);
  const entry = resolveFreshestSessionEntryFromStoreKeys(store, target.storeKeys);
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
  const limit = resolveLimit(req);
  const cursor = normalizeOptionalString(getRequestUrl(req).searchParams.get("cursor"));
  const effectiveMaxChars =
    typeof cfg.gateway?.webchat?.chatHistoryMaxChars === "number"
      ? cfg.gateway.webchat.chatHistoryMaxChars
      : DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS;
  const boundedSnapshot =
    cursor === undefined && typeof limit === "number"
      ? await readRecentSessionMessagesWithStatsAsync(
          entry.sessionId,
          target.storePath,
          entry.sessionFile,
          resolveSessionHistoryTailReadOptions(limit),
        )
      : undefined;
  // Cursor reads still need an arbitrary historical window. The common first
  // page path is bounded above so `limit=1` cannot materialize huge transcripts.
  const rawSnapshot =
    boundedSnapshot?.messages ??
    (entry?.sessionId
      ? await readSessionMessagesAsync(entry.sessionId, target.storePath, entry.sessionFile, {
          mode: "full",
          reason: "session history cursor pagination",
        })
      : []);
  const historySnapshot = buildSessionHistorySnapshot({
    rawMessages: rawSnapshot,
    maxChars: effectiveMaxChars,
    limit,
    cursor,
    rawTranscriptSeq: boundedSnapshot?.totalMessages,
    totalRawMessages: boundedSnapshot?.totalMessages,
  });
  const history = historySnapshot.history;

  if (!shouldStreamSse(req)) {
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
          entry.sessionFile,
          target.agentId,
        )
          .map((candidate) => canonicalizePath(candidate))
          .filter((candidate): candidate is string => typeof candidate === "string"),
      )
    : new Set<string>();

  let sentHistory = history;
  const sseState = SessionHistorySseState.fromRawSnapshot({
    target: {
      sessionId: entry.sessionId,
      storePath: target.storePath,
      sessionFile: entry.sessionFile,
    },
    rawMessages: rawSnapshot,
    rawTranscriptSeq: boundedSnapshot?.totalMessages,
    totalRawMessages: boundedSnapshot?.totalMessages,
    maxChars: effectiveMaxChars,
    limit,
    cursor,
  });
  sentHistory = sseState.snapshot();
  setSseHeaders(res);
  res.write("retry: 1000\n\n");
  sseWrite(res, "history", {
    sessionKey: target.canonicalKey,
    ...sentHistory,
  });

  let cleanedUp = false;
  let streamQueue = Promise.resolve();
  // Forward-declared so `cleanup` can reference them without relying on
  // Temporal-Dead-Zone leniency. A future refactor that wires the close event
  // listeners before the `setInterval` / `onSessionTranscriptUpdate` calls
  // would otherwise hit a `ReferenceError` on the first cleanup invocation.
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let unsubscribe: (() => void) | undefined;

  const cleanup = () => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    if (heartbeat) {
      clearInterval(heartbeat);
    }
    if (unsubscribe) {
      unsubscribe();
    }
  };

  const closeStream = () => {
    cleanup();
    if (!res.writableEnded) {
      res.end();
    }
  };

  const queueStreamWork = (work: () => Promise<void>) => {
    streamQueue = streamQueue
      .then(async () => {
        if (cleanedUp || res.writableEnded) {
          return;
        }
        await work();
      })
      .catch((error) => {
        // Surface the underlying error so operators can distinguish transient
        // infrastructure failures (for example a `getRuntimeConfig()` read error
        // inside the reauth path) from deliberate revocation, then fail closed.
        log.warn("session history SSE stream work failed; closing stream", { error });
        closeStream();
      });
  };

  const isStreamStillAuthorized = async (): Promise<boolean> => {
    const cfg = getRuntimeConfig();
    const currentRequestAuth = await checkGatewayHttpRequestAuth({
      req,
      auth: opts.getResolvedAuth?.() ?? opts.auth,
      trustedProxies: cfg.gateway?.trustedProxies,
      allowRealIpFallback: cfg.gateway?.allowRealIpFallback,
      rateLimiter: opts.rateLimiter,
      cfg,
    });
    if (!currentRequestAuth.ok) {
      return false;
    }
    const requestedScopes = resolveTrustedHttpOperatorScopes(req, currentRequestAuth.requestAuth);
    return authorizeOperatorScopesForMethod("chat.history", requestedScopes).allowed;
  };

  heartbeat = setInterval(() => {
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

  unsubscribe = onSessionTranscriptUpdate((update) => {
    // Filter to candidate sessions synchronously before enqueueing any async
    // work. `onSessionTranscriptUpdate` is a global fan-out listener, so every
    // transcript write in the gateway would otherwise append a Promise-chain
    // entry capturing `update.message` to every open SSE stream's queue —
    // O(streams × updates) for busy deployments.
    if (!entry?.sessionId) {
      return;
    }
    const updatePath = canonicalizePath(update.sessionFile);
    if (!updatePath || !transcriptCandidates.has(updatePath)) {
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
            sseWrite(res, "history", {
              sessionKey: target.canonicalKey,
              ...sentHistory,
            });
            return;
          }
          if (nextEvent.message === undefined) {
            return;
          }
          sentHistory = sseState.snapshot();
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
      sseWrite(res, "history", {
        sessionKey: target.canonicalKey,
        ...sentHistory,
      });
    });
  });
  req.on("close", cleanup);
  res.on("close", cleanup);
  res.on("finish", cleanup);
  return true;
}
