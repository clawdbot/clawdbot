// Resolves approval delivery targets from sessions and turn sources.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveSessionConversationRef } from "../channels/plugins/session-conversation.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeMessageChannel } from "../utils/message-channel.js";
import {
  doesApprovalRequestMatchChannelAccount,
  resolvePersistedApprovalRequestSessionEntry,
} from "./approval-request-account-binding.js";
import { normalizeApprovalRequest, type ApprovalRequestInput } from "./approval-types.js";
import type { ExecApprovalRequest } from "./exec-approvals.js";
import { resolveSessionDeliveryTarget } from "./outbound/targets.js";

/** Delivery target recovered from an approval request's live turn-source or stored session. */
export type ExecApprovalSessionTarget = {
  channel?: string;
  to: string;
  accountId?: string;
  threadId?: string | number;
};

/** Parsed session conversation metadata used by channel-native approval routing. */
export type ApprovalRequestSessionConversation = {
  channel: string;
  kind: "group" | "channel";
  id: string;
  rawId: string;
  threadId?: string;
  baseSessionKey: string;
  baseConversationId: string;
  parentConversationCandidates: string[];
};

type ApprovalRequestLike = ApprovalRequestInput;
type ApprovalRequestOriginTargetResolver<TTarget> = {
  cfg: OpenClawConfig;
  request: ApprovalRequestLike;
  channel: string;
  accountId?: string | null;
  resolveTurnSourceTarget: (request: ApprovalRequestLike) => TTarget | null;
  resolveSessionTarget: (sessionTarget: ExecApprovalSessionTarget) => TTarget | null;
  targetsMatch: (a: TTarget, b: TTarget) => boolean;
  // Reconciles a coarse turn-source route (omitting an optional dimension such as a forum thread)
  // to the persisted session target when strict targetsMatch fails; returning null stays fail-closed.
  reconcileTargets?: (turnSourceTarget: TTarget, sessionTarget: TTarget) => TTarget | null;
  resolveFallbackTarget?: (request: ApprovalRequestLike) => TTarget | null;
};

function normalizeExecApprovalThreadValue(
  value?: string | number | null,
): string | number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized ? normalized : undefined;
}

function toExecLikeApprovalRequest(request: ApprovalRequestLike): ExecApprovalRequest {
  const normalizedRequest = normalizeApprovalRequest(request);
  if (normalizedRequest.approvalKind === "exec") {
    return normalizedRequest;
  }
  return {
    approvalKind: "exec",
    id: normalizedRequest.id,
    request: {
      command: normalizedRequest.request.title,
      sessionKey: normalizedRequest.request.sessionKey ?? undefined,
      turnSourceChannel: normalizedRequest.request.turnSourceChannel ?? undefined,
      turnSourceTo: normalizedRequest.request.turnSourceTo ?? undefined,
      turnSourceAccountId: normalizedRequest.request.turnSourceAccountId ?? undefined,
      turnSourceThreadId: normalizedRequest.request.turnSourceThreadId ?? undefined,
    },
    createdAtMs: normalizedRequest.createdAtMs,
    expiresAtMs: normalizedRequest.expiresAtMs,
  };
}

function normalizeOptionalChannel(value?: string | null): string | undefined {
  return normalizeMessageChannel(value);
}

/** Resolves the conversation encoded in an approval request session key for an optional channel. */
export function resolveApprovalRequestSessionConversation(params: {
  request: ApprovalRequestLike;
  channel?: string | null;
  bundledFallback?: boolean;
}): ApprovalRequestSessionConversation | null {
  const sessionKey = normalizeOptionalString(params.request.request.sessionKey);
  if (!sessionKey) {
    return null;
  }
  const resolved = resolveSessionConversationRef(sessionKey, {
    bundledFallback: params.bundledFallback,
  });
  if (!resolved) {
    return null;
  }
  const expectedChannel = normalizeOptionalChannel(params.channel);
  if (expectedChannel && normalizeOptionalChannel(resolved.channel) !== expectedChannel) {
    return null;
  }
  return {
    channel: resolved.channel,
    kind: resolved.kind,
    id: resolved.id,
    rawId: resolved.rawId,
    threadId: resolved.threadId,
    baseSessionKey: resolved.baseSessionKey,
    baseConversationId: resolved.baseConversationId,
    parentConversationCandidates: resolved.parentConversationCandidates,
  };
}

/** Resolves the best known message target for an exec approval request. */
export function resolveExecApprovalSessionTarget(params: {
  cfg: OpenClawConfig;
  request: ExecApprovalRequest;
  turnSourceChannel?: string | null;
  turnSourceTo?: string | null;
  turnSourceAccountId?: string | null;
  turnSourceThreadId?: string | number | null;
}): ExecApprovalSessionTarget | null {
  const sessionKey = normalizeOptionalString(params.request.request.sessionKey);
  if (!sessionKey) {
    return null;
  }
  const persisted = resolvePersistedApprovalRequestSessionEntry({
    cfg: params.cfg,
    request: params.request,
  });
  if (!persisted) {
    return null;
  }

  const target = resolveSessionDeliveryTarget({
    entry: persisted.entry,
    requestedChannel: "last",
    turnSourceChannel: normalizeOptionalString(params.turnSourceChannel),
    turnSourceTo: normalizeOptionalString(params.turnSourceTo),
    turnSourceAccountId: normalizeOptionalString(params.turnSourceAccountId),
    turnSourceThreadId: normalizeExecApprovalThreadValue(params.turnSourceThreadId),
  });
  if (!target.to) {
    return null;
  }

  return {
    channel: normalizeOptionalString(target.channel),
    to: target.to,
    accountId: normalizeOptionalString(target.accountId),
    threadId: normalizeExecApprovalThreadValue(target.threadId),
  };
}

/** Resolves the best known message target for either exec or plugin approval requests. */
export function resolveApprovalRequestSessionTarget(params: {
  cfg: OpenClawConfig;
  request: ApprovalRequestLike;
}): ExecApprovalSessionTarget | null {
  const execLikeRequest = toExecLikeApprovalRequest(params.request);
  return resolveExecApprovalSessionTarget({
    cfg: params.cfg,
    request: execLikeRequest,
    turnSourceChannel: execLikeRequest.request.turnSourceChannel ?? undefined,
    turnSourceTo: execLikeRequest.request.turnSourceTo ?? undefined,
    turnSourceAccountId: execLikeRequest.request.turnSourceAccountId ?? undefined,
    turnSourceThreadId: execLikeRequest.request.turnSourceThreadId ?? undefined,
  });
}

function resolveApprovalRequestStoredSessionTarget(params: {
  cfg: OpenClawConfig;
  request: ApprovalRequestLike;
}): ExecApprovalSessionTarget | null {
  const execLikeRequest = toExecLikeApprovalRequest(params.request);
  return resolveExecApprovalSessionTarget({
    cfg: params.cfg,
    request: execLikeRequest,
  });
}

/** Resolves a channel-specific origin target only when live and stored bindings are consistent. */
export function resolveApprovalRequestOriginTarget<TTarget>(
  params: ApprovalRequestOriginTargetResolver<TTarget>,
): TTarget | null {
  if (
    !doesApprovalRequestMatchChannelAccount({
      cfg: params.cfg,
      request: params.request,
      channel: params.channel,
      accountId: params.accountId,
    })
  ) {
    return null;
  }

  const turnSourceTarget = params.resolveTurnSourceTarget(params.request);
  const expectedChannel = normalizeOptionalChannel(params.channel);
  const sessionTargetBinding = resolveApprovalRequestStoredSessionTarget({
    cfg: params.cfg,
    request: params.request,
  });
  const sessionTarget =
    sessionTargetBinding &&
    normalizeOptionalChannel(sessionTargetBinding.channel) === expectedChannel
      ? params.resolveSessionTarget(sessionTargetBinding)
      : null;

  if (turnSourceTarget && sessionTarget && !params.targetsMatch(turnSourceTarget, sessionTarget)) {
    // Omitted optional route dimensions (thread, account) mean "no opinion", not disagreement;
    // reconcile a coarse turn-source route to the persisted session target before failing closed.
    return params.reconcileTargets?.(turnSourceTarget, sessionTarget) ?? null;
  }

  return (
    turnSourceTarget ?? sessionTarget ?? params.resolveFallbackTarget?.(params.request) ?? null
  );
}
