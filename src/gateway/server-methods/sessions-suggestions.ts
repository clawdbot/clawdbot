import {
  ErrorCodes,
  errorShape,
  validateSessionSuggestionsAddParams,
  validateSessionSuggestionsListParams,
  validateSessionSuggestionsResolveParams,
  validateSessionTypingParams,
  type SessionSuggestion,
  type SessionSuggestionEvent,
  type SessionSuggestionResolution,
  type SessionSharingIdentity,
  type SessionTypingEvent,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  addSessionSuggestion,
  claimSessionSuggestionDispatch,
  finalizeSessionSuggestionClaim,
  isSessionWorkStartInvalidatedError,
  listSessionSuggestions,
  releaseSessionSuggestionDispatch,
  resolveSessionWorkStartError,
  SESSION_SUGGESTION_DISPATCH_CLAIM_TTL_MS,
  type StoredSessionSuggestion,
} from "../../config/sessions.js";
import {
  authorizeIncognitoSessionTarget,
  authorizeSessionSharingTarget,
  canManageSessionSharing,
  resolveSessionSharingRole,
  resolveSessionSharingTarget,
  resolveSessionVisibility,
} from "../session-sharing.js";
import { handleChatSend } from "./chat-send-handler.js";
import { gatewayClientSessionCreator } from "./gateway-client-identity.js";
import { appendSessionAudit } from "./session-audit.js";
import {
  broadcastTypingThrottled,
  liveViewerIdentities,
  updateTypingConnections,
} from "./session-typing-state.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlers,
  RespondFn,
} from "./types.js";
import { assertValidParams } from "./validation.js";

function suggestionScope(target: NonNullable<ReturnType<typeof resolveSessionSharingTarget>>) {
  return {
    agentId: target.agentId,
    sessionKey: target.storeKey,
    storePath: target.storePath,
  };
}

function protocolSuggestion(
  target: NonNullable<ReturnType<typeof resolveSessionSharingTarget>>,
  suggestion: StoredSessionSuggestion,
): SessionSuggestion {
  return {
    id: suggestion.id,
    sessionKey: target.canonicalKey,
    agentId: target.agentId,
    author: {
      type: "human",
      id: suggestion.authorId,
      ...(suggestion.authorLabel ? { label: suggestion.authorLabel } : {}),
    },
    text: suggestion.text,
    createdAt: suggestion.createdAt,
    state: suggestion.state,
  };
}

function requireSuggestionTarget(params: {
  context: GatewayRequestContext;
  sessionKey: string;
  agentId?: string;
  respond: RespondFn;
}) {
  const target = resolveSessionSharingTarget({
    cfg: params.context.getRuntimeConfig(),
    sessionKey: params.sessionKey,
    agentId: params.agentId,
  });
  if (!target) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `unknown session: ${params.sessionKey}`),
    );
    return null;
  }
  return target;
}

function requireVisibleSuggestionRole(params: {
  client: GatewayClient | null;
  sessionKey: string;
  target: NonNullable<ReturnType<typeof resolveSessionSharingTarget>>;
  respond: RespondFn;
}) {
  const role = resolveSessionSharingRole({ client: params.client, target: params.target });
  const incognitoError = authorizeIncognitoSessionTarget({
    client: params.client,
    sessionKey: params.sessionKey,
    target: params.target,
  });
  if (incognitoError) {
    params.respond(false, undefined, incognitoError);
    return null;
  }
  if (resolveSessionVisibility(params.target.entry) !== "draft") {
    return role;
  }
  const error = authorizeSessionSharingTarget({ client: params.client, target: params.target });
  if (!error) {
    return role;
  }
  params.respond(false, undefined, error);
  return null;
}

function publishSuggestion(
  context: GatewayRequestContext,
  target: NonNullable<ReturnType<typeof resolveSessionSharingTarget>>,
  requestedSessionKey: string,
  event: SessionSuggestionEvent,
): void {
  context.broadcast("session.suggestion", event, {
    sessionKeys: [
      ...new Set([requestedSessionKey, target.canonicalKey, target.storeKey]),
    ].toSorted(),
    agentId: event.suggestion.agentId,
  });
}

function resolutionState(resolution: SessionSuggestionResolution): "accepted" | "dismissed" {
  return resolution === "dismiss" ? "dismissed" : "accepted";
}

function respondSessionSuggestionSessionChanged(respond: RespondFn, sessionKey: string): void {
  respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.UNAVAILABLE,
      "session changed before suggestion resolution could be finalized",
      {
        retryable: false,
        details: {
          code: "SESSION_SUGGESTION_SESSION_CHANGED",
          sessionKey,
        },
      },
    ),
  );
}

function runSessionSuggestionMutation<T>(params: {
  mutate: () => T;
  respond: RespondFn;
  sessionKey: string;
}): { ok: true; value: T } | { ok: false } {
  try {
    return { ok: true, value: params.mutate() };
  } catch (error) {
    if (!isSessionWorkStartInvalidatedError(error)) {
      throw error;
    }
    respondSessionSuggestionSessionChanged(params.respond, params.sessionKey);
    return { ok: false };
  }
}

function resolutionAuditAction(resolution: SessionSuggestionResolution): string {
  switch (resolution) {
    case "send":
      return "sent a suggestion immediately";
    case "queue":
      return "queued a suggestion";
    case "edit":
      return "moved a suggestion into the composer";
    case "dismiss":
      return "dismissed a suggestion";
  }
  throw new Error(`unsupported suggestion resolution: ${String(resolution)}`);
}

function actorIdentity(client: GatewayClient | null): SessionSharingIdentity {
  return (
    gatewayClientSessionCreator(client) ?? {
      type: "system",
      id: "operator.admin",
      label: "Administrator",
    }
  );
}

function attributedSuggestionClient(
  client: GatewayClient,
  suggestion: StoredSessionSuggestion,
): GatewayClient {
  const label = suggestion.authorLabel ?? suggestion.authorId;
  return {
    ...client,
    internal: {
      ...client.internal,
      syntheticClient: true,
      senderAttribution: {
        id: suggestion.authorId,
        name: `Suggested by ${label}`,
      },
    },
  };
}

async function dispatchSuggestion(params: {
  context: GatewayRequestContext;
  client: GatewayClient;
  req: Parameters<GatewayRequestHandlers[string]>[0]["req"];
  isWebchatConnect: Parameters<GatewayRequestHandlers[string]>[0]["isWebchatConnect"];
  target: NonNullable<ReturnType<typeof resolveSessionSharingTarget>>;
  suggestion: StoredSessionSuggestion;
  resolution: "send" | "queue";
}): Promise<{ ok: true } | { ok: false; error: Parameters<RespondFn>[2] }> {
  let response: Parameters<RespondFn> | undefined;
  const chatParams = {
    sessionKey: params.target.canonicalKey,
    agentId: params.target.agentId,
    sessionId: params.target.entry.sessionId,
    message: params.suggestion.text,
    queueMode: params.resolution === "send" ? "steer" : "followup",
    idempotencyKey: `session-suggestion:${params.suggestion.id}`,
  };
  await handleChatSend({
    req: { ...params.req, method: "chat.send", params: chatParams },
    params: chatParams,
    client: attributedSuggestionClient(params.client, params.suggestion),
    isWebchatConnect: params.isWebchatConnect,
    respond: (...args) => {
      response = args;
    },
    context: params.context,
  });
  return response?.[0] === true ? { ok: true } : { ok: false, error: response?.[2] };
}

export const sessionSuggestionHandlers: GatewayRequestHandlers = {
  "session.suggestions.add": ({ params, respond, client, context }) => {
    if (
      !assertValidParams(
        params,
        validateSessionSuggestionsAddParams,
        "session.suggestions.add",
        respond,
      )
    ) {
      return;
    }
    const target = requireSuggestionTarget({ context, ...params, respond });
    const author = gatewayClientSessionCreator(client);
    if (!target) {
      return;
    }
    if (
      requireVisibleSuggestionRole({ client, sessionKey: params.sessionKey, target, respond }) ===
      null
    ) {
      return;
    }
    const lifecycleError = resolveSessionWorkStartError(target.canonicalKey, target.entry);
    if (lifecycleError) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, lifecycleError));
      return;
    }
    if (!author) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "identified suggestion author required"),
      );
      return;
    }
    if (resolveSessionVisibility(target.entry) !== "suggest") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "session is not accepting suggestions"),
      );
      return;
    }
    const text = params.text;
    if (!text.trim()) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "suggestion text is required"),
      );
      return;
    }
    let suggestion: StoredSessionSuggestion;
    try {
      suggestion = addSessionSuggestion(suggestionScope(target), {
        authorId: author.id,
        authorLabel: author.label,
        text,
        expectedSessionId: target.entry.sessionId,
      });
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          error instanceof Error ? error.message : "suggestion could not be stored",
        ),
      );
      return;
    }
    const projected = protocolSuggestion(target, suggestion);
    publishSuggestion(context, target, params.sessionKey, {
      action: "added",
      suggestion: projected,
    });
    respond(true, { suggestion: projected });
  },

  "session.suggestions.list": ({ params, respond, client, context }) => {
    if (
      !assertValidParams(
        params,
        validateSessionSuggestionsListParams,
        "session.suggestions.list",
        respond,
      )
    ) {
      return;
    }
    const target = requireSuggestionTarget({ context, ...params, respond });
    if (!target) {
      return;
    }
    const role = requireVisibleSuggestionRole({
      client,
      sessionKey: params.sessionKey,
      target,
      respond,
    });
    if (role === null) {
      return;
    }
    const identity = gatewayClientSessionCreator(client);
    const stored =
      role === "viewer"
        ? identity
          ? listSessionSuggestions(suggestionScope(target), { authorId: identity.id })
          : []
        : listSessionSuggestions(suggestionScope(target)).filter(
            (suggestion) => suggestion.state === "pending" || suggestion.authorId === identity?.id,
          );
    respond(true, {
      role,
      suggestions: stored.map((suggestion) => protocolSuggestion(target, suggestion)),
    });
  },

  "session.suggestions.resolve": async ({
    params,
    respond,
    client,
    context,
    req,
    isWebchatConnect,
  }) => {
    if (
      !assertValidParams(
        params,
        validateSessionSuggestionsResolveParams,
        "session.suggestions.resolve",
        respond,
      )
    ) {
      return;
    }
    const target = requireSuggestionTarget({ context, ...params, respond });
    if (!target) {
      return;
    }
    const role = requireVisibleSuggestionRole({
      client,
      sessionKey: params.sessionKey,
      target,
      respond,
    });
    if (role === null) {
      return;
    }
    if (role !== "owner" && role !== "admin") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "session owner or operator.admin required"),
      );
      return;
    }
    const resolution = params.resolution as SessionSuggestionResolution;
    const dispatching = resolution === "send" || resolution === "queue";
    if (resolution !== "dismiss") {
      const lifecycleError = resolveSessionWorkStartError(target.canonicalKey, target.entry);
      if (lifecycleError) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, lifecycleError));
        return;
      }
    }
    if (dispatching && !client) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "connected client required for suggestion dispatch"),
      );
      return;
    }
    const scope = suggestionScope(target);
    const claimResult = runSessionSuggestionMutation({
      respond,
      sessionKey: params.sessionKey,
      mutate: () =>
        claimSessionSuggestionDispatch(scope, {
          id: params.id,
          resolution,
          expectedSessionId: target.entry.sessionId,
        }),
    });
    if (!claimResult.ok) {
      return;
    }
    const claim = claimResult.value;
    if (!claim) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "pending suggestion not found"),
      );
      return;
    }
    if (claim.kind === "busy") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "suggestion resolution is already in progress", {
          retryable: true,
          retryAfterMs: SESSION_SUGGESTION_DISPATCH_CLAIM_TTL_MS,
        }),
      );
      return;
    }
    if (claim.kind === "mismatch") {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `suggestion dispatch recovery must retry the original ${claim.resolution} action`,
        ),
      );
      return;
    }
    if (dispatching && client) {
      let dispatched: Awaited<ReturnType<typeof dispatchSuggestion>>;
      try {
        dispatched = await dispatchSuggestion({
          context,
          client,
          req,
          isWebchatConnect,
          target,
          suggestion: claim.suggestion,
          resolution,
        });
      } catch (error) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            error instanceof Error ? error.message : "suggestion dispatch outcome is unknown",
            {
              retryable: true,
              retryAfterMs: SESSION_SUGGESTION_DISPATCH_CLAIM_TTL_MS,
            },
          ),
        );
        return;
      }
      if (!dispatched.ok) {
        let releaseResult: ReturnType<typeof runSessionSuggestionMutation<boolean>>;
        try {
          releaseResult = runSessionSuggestionMutation({
            respond,
            sessionKey: params.sessionKey,
            mutate: () =>
              releaseSessionSuggestionDispatch(scope, {
                id: claim.suggestion.id,
                token: claim.token,
                expectedSessionId: target.entry.sessionId,
              }),
          });
        } catch (error) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.UNAVAILABLE,
              error instanceof Error ? error.message : "suggestion dispatch outcome is unknown",
              {
                retryable: true,
                retryAfterMs: SESSION_SUGGESTION_DISPATCH_CLAIM_TTL_MS,
              },
            ),
          );
          return;
        }
        if (!releaseResult.ok) {
          return;
        }
        respond(
          false,
          undefined,
          dispatched.error ?? errorShape(ErrorCodes.INVALID_REQUEST, "suggestion dispatch failed"),
        );
        return;
      }
    }
    const currentTarget = resolveSessionSharingTarget({
      cfg: context.getRuntimeConfig(),
      sessionKey: params.sessionKey,
      agentId: params.agentId,
    });
    if (!currentTarget || currentTarget.entry.sessionId !== target.entry.sessionId) {
      // Session replacement clears session_suggestions in the same entry-store
      // write, so the old claim is already terminal. Never finalize or publish it
      // against the replacement instance after an accepted dispatch.
      respondSessionSuggestionSessionChanged(respond, params.sessionKey);
      return;
    }
    const finalizeResult = runSessionSuggestionMutation({
      respond,
      sessionKey: params.sessionKey,
      mutate: () =>
        finalizeSessionSuggestionClaim(scope, {
          id: claim.suggestion.id,
          token: claim.token,
          state: resolutionState(resolution),
          expectedSessionId: target.entry.sessionId,
        }),
    });
    if (!finalizeResult.ok) {
      return;
    }
    const suggestion = finalizeResult.value;
    if (!suggestion) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "suggestion resolution could not be finalized", {
          retryable: true,
        }),
      );
      return;
    }
    const projected = protocolSuggestion(target, suggestion);
    publishSuggestion(context, target, params.sessionKey, {
      action: "resolved",
      suggestion: projected,
    });
    const actor = actorIdentity(client);
    try {
      await appendSessionAudit({
        cfg: context.getRuntimeConfig(),
        target,
        text: `${actor.label ?? actor.id} ${resolutionAuditAction(resolution)}.`,
        now: Date.now(),
      });
    } catch (error) {
      context.logGateway.warn(`failed to append suggestion resolution audit: ${String(error)}`);
    }
    respond(true, { suggestion: projected });
  },

  "session.typing": ({ params, respond, client, context }) => {
    if (!assertValidParams(params, validateSessionTypingParams, "session.typing", respond)) {
      return;
    }
    const target = requireSuggestionTarget({ context, ...params, respond });
    const actor = gatewayClientSessionCreator(client);
    if (!target) {
      return;
    }
    const incognitoError = authorizeIncognitoSessionTarget({
      client,
      sessionKey: params.sessionKey,
      target,
    });
    if (incognitoError) {
      respond(false, undefined, incognitoError);
      return;
    }
    if (params.sessionId !== target.entry.sessionId) {
      respond(true, { ok: true, broadcast: false });
      return;
    }
    if (!actor) {
      respond(true, { ok: true, broadcast: false });
      return;
    }
    const role = resolveSessionSharingRole({ client, target });
    const visibility = resolveSessionVisibility(target.entry);
    if (visibility === "draft" && !canManageSessionSharing(role)) {
      respond(true, { ok: true, broadcast: false });
      return;
    }
    if (role === "viewer" && visibility !== "shared" && visibility !== "suggest") {
      respond(true, { ok: true, broadcast: false });
      return;
    }
    const sessionKeys = new Set([params.sessionKey, target.canonicalKey, target.storeKey]);
    const now = Date.now();
    const typingKey = `${actor.id}\0${target.agentId}\0${target.canonicalKey}\0${target.entry.sessionId}`;
    const effectiveTyping = updateTypingConnections({
      key: typingKey,
      connectionId: client?.connId ?? actor.id,
      typing: params.typing,
      now,
    });
    if (!params.typing && effectiveTyping) {
      respond(true, { ok: true, broadcast: false });
      return;
    }
    const broadcast = broadcastTypingThrottled({
      key: typingKey,
      typing: effectiveTyping,
      now,
      emit: () => {
        const current = resolveSessionSharingTarget({
          cfg: context.getRuntimeConfig(),
          sessionKey: params.sessionKey,
          agentId: params.agentId,
        });
        if (!current || current.entry.sessionId !== target.entry.sessionId) {
          return false;
        }
        const currentRole = resolveSessionSharingRole({ client, target: current });
        const currentVisibility = resolveSessionVisibility(current.entry);
        if (currentVisibility === "draft" && !canManageSessionSharing(currentRole)) {
          return false;
        }
        if (
          currentRole === "viewer" &&
          currentVisibility !== "shared" &&
          currentVisibility !== "suggest"
        ) {
          return false;
        }
        const liveIdentities = liveViewerIdentities(sessionKeys);
        if (liveIdentities.size < 2 || !liveIdentities.has(actor.id)) {
          return false;
        }
        const event: SessionTypingEvent = {
          sessionKey: target.canonicalKey,
          sessionId: current.entry.sessionId,
          agentId: target.agentId,
          actor,
          typing: effectiveTyping,
          ts: Date.now(),
        };
        context.broadcast("session.typing", event, {
          sessionKeys: [...sessionKeys].toSorted(),
          agentId: target.agentId,
          dropIfSlow: true,
        });
        return true;
      },
    });
    respond(true, { ok: true, broadcast });
  },
};
