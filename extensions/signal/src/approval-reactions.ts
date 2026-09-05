// Signal plugin module implements approval reactions behavior.
import type { ApprovalResolveResult } from "openclaw/plugin-sdk/approval-gateway-runtime";
import type { ChannelApprovalKind } from "openclaw/plugin-sdk/approval-handler-runtime";
import {
  addApprovalReactionHintToText,
  createApprovalReactionTargetStore,
  hasApprovalReactionHintText,
  listApprovalReactionBindings,
  readApprovalReactionDecisionList,
  resolveTypedApprovalReactionTarget,
  type ApprovalReactionTargetRecord,
} from "openclaw/plugin-sdk/approval-reaction-runtime";
import {
  getExecApprovalReplyMetadata,
  type ExecApprovalReplyDecision,
} from "openclaw/plugin-sdk/approval-reply-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { isApprovalNotFoundError } from "openclaw/plugin-sdk/error-runtime";
import { createLazyRuntimeSurface } from "openclaw/plugin-sdk/lazy-runtime";
import { createPluginStateErrorReporter } from "openclaw/plugin-sdk/plugin-state-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { normalizeAccountId } from "openclaw/plugin-sdk/routing";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeE164 } from "openclaw/plugin-sdk/text-utility-runtime";
import { resolveSignalDeliveredConversationKey } from "./aliases.js";
import { getSignalApprovalApprovers, signalApprovalAuth } from "./approval-auth.js";
import {
  buildTargetRoute,
  isSignalApprovalReactionRouteStillEnabled,
  type SignalApprovalReactionRoute,
} from "./approval-reaction-routes.js";
import { looksLikeUuid } from "./identity.js";
import { normalizeSignalMessagingTarget } from "./normalize.js";
import { getOptionalSignalRuntime } from "./runtime.js";

const PERSISTENT_NAMESPACE = "signal.approval-reactions.v2";
const PERSISTENT_MAX_ENTRIES = 1000;
const DEFAULT_REACTION_TARGET_TTL_MS = 24 * 60 * 60 * 1000;

type SignalApprovalReactionResolution = {
  approvalId: string;
  approvalKind: ChannelApprovalKind;
  decision: ExecApprovalReplyDecision;
  route: SignalApprovalReactionRoute;
};

type SignalApprovalReactionTarget = ApprovalReactionTargetRecord<SignalApprovalReactionRoute> & {
  approvalKind: ChannelApprovalKind;
  targetAuthorKeys: readonly string[];
  route: SignalApprovalReactionRoute;
};

type SignalApprovalDeliveryTarget = {
  channel: string;
  to: string;
  accountId?: string | null;
};

type SignalApprovalDeliveryResult = {
  channel?: string;
  messageId?: string | null;
  toJid?: string;
  meta?: Record<string, unknown>;
};

const loadResolveApprovalOverGateway = createLazyRuntimeSurface(
  () => import("openclaw/plugin-sdk/approval-gateway-runtime"),
  (runtime) => runtime.resolveApprovalOverGateway,
);

const reportPersistentApprovalReactionError = createPluginStateErrorReporter(
  getOptionalSignalRuntime,
  "signal",
  "approval-reaction-state",
  "Signal persistent approval reaction state failed",
);

const signalApprovalReactionTargets =
  createApprovalReactionTargetStore<SignalApprovalReactionTarget>({
    namespace: PERSISTENT_NAMESPACE,
    maxEntries: PERSISTENT_MAX_ENTRIES,
    defaultTtlMs: DEFAULT_REACTION_TARGET_TTL_MS,
    openStore: (storeParams) => getOptionalSignalRuntime()?.state.openKeyedStore(storeParams),
    logPersistentError: reportPersistentApprovalReactionError,
    readPersistedTarget,
  });

export function resolveSignalApprovalConversationKey(to: string): string | null {
  return normalizeSignalMessagingTarget(to) ?? null;
}

function normalizeSignalApprovalTargetAuthorKey(value: string): string | null {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return null;
  }
  const withoutSignalPrefix = normalized.replace(/^signal:/i, "").trim();
  const lower = normalizeLowercaseStringOrEmpty(withoutSignalPrefix);
  if (lower.startsWith("uuid:")) {
    const uuid = withoutSignalPrefix.slice("uuid:".length).trim().toLowerCase();
    return uuid ? `uuid:${uuid}` : null;
  }
  if (looksLikeUuid(withoutSignalPrefix)) {
    return `uuid:${withoutSignalPrefix.toLowerCase()}`;
  }
  return normalizeE164(withoutSignalPrefix);
}

export function resolveSignalApprovalTargetAuthorKeys(params: {
  targetAuthor?: string | null;
  targetAuthorUuid?: string | null;
}): string[] {
  const targetAuthorUuid = normalizeOptionalString(params.targetAuthorUuid);
  const keys = [
    targetAuthorUuid
      ? `uuid:${targetAuthorUuid
          .replace(/^uuid:/i, "")
          .trim()
          .toLowerCase()}`
      : null,
    params.targetAuthor ? normalizeSignalApprovalTargetAuthorKey(params.targetAuthor) : null,
  ].filter((key): key is string => Boolean(key));
  return Array.from(new Set(keys));
}

function buildReactionTargetKey(params: {
  accountId: string;
  conversationKey: string;
  messageId: string;
}) {
  const accountId = params.accountId.trim();
  const conversationKey = params.conversationKey.trim();
  const messageId = params.messageId.trim();
  if (!accountId || !conversationKey || !messageId || messageId === "unknown") {
    return null;
  }
  return `${accountId}:${conversationKey}:${messageId}`;
}

function readPersistedTarget(target: unknown): SignalApprovalReactionTarget | null {
  const value = target as Partial<SignalApprovalReactionTarget> | null | undefined;
  if (
    !value ||
    typeof value.approvalId !== "string" ||
    (value.approvalKind !== "exec" && value.approvalKind !== "plugin") ||
    !value.route ||
    (value.route.deliveryMode !== "session" && value.route.deliveryMode !== "target") ||
    !Array.isArray(value.targetAuthorKeys)
  ) {
    return null;
  }
  const allowedDecisions = readApprovalReactionDecisionList(value.allowedDecisions);
  if (!allowedDecisions) {
    return null;
  }
  const targetRouteTo =
    value.route.deliveryMode === "target" && typeof value.route.to === "string"
      ? normalizeSignalMessagingTarget(value.route.to)
      : null;
  if (value.route.deliveryMode === "target" && !targetRouteTo) {
    return null;
  }
  const route: SignalApprovalReactionRoute =
    value.route.deliveryMode === "target"
      ? {
          deliveryMode: "target",
          to: targetRouteTo!,
          ...(typeof value.route.accountId === "string"
            ? { accountId: value.route.accountId }
            : {}),
          ...(typeof value.route.agentId === "string" ? { agentId: value.route.agentId } : {}),
          ...(typeof value.route.sessionKey === "string"
            ? { sessionKey: value.route.sessionKey }
            : {}),
        }
      : {
          deliveryMode: "session",
          ...(typeof value.route.agentId === "string" ? { agentId: value.route.agentId } : {}),
          ...(typeof value.route.sessionKey === "string"
            ? { sessionKey: value.route.sessionKey }
            : {}),
        };
  return {
    approvalId: value.approvalId,
    approvalKind: value.approvalKind,
    allowedDecisions,
    targetAuthorKeys: value.targetAuthorKeys,
    route,
  };
}

export function hasSignalApprovalReactionApprovers(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean {
  return getSignalApprovalApprovers(params).length > 0;
}

export function registerSignalApprovalReactionTarget(params: {
  accountId: string;
  conversationKey: string;
  messageId: string;
  approvalId: string;
  approvalKind: ChannelApprovalKind;
  allowedDecisions: readonly ExecApprovalReplyDecision[];
  targetAuthorKeys: readonly string[];
  route: SignalApprovalReactionRoute;
  routeAllowed: boolean;
  ttlMs?: number;
}): SignalApprovalReactionTarget | null {
  const key = buildReactionTargetKey(params);
  const approvalId = params.approvalId.trim();
  const targetAuthorKeys = Array.from(
    new Set(
      params.targetAuthorKeys
        .map((entry) => normalizeSignalApprovalTargetAuthorKey(entry))
        .filter((entry): entry is string => Boolean(entry)),
    ),
  );
  const allowedDecisions = listApprovalReactionBindings({
    allowedDecisions: params.allowedDecisions,
  }).map((binding) => binding.decision);
  if (
    !params.routeAllowed ||
    (params.approvalKind !== "exec" && params.approvalKind !== "plugin") ||
    !key ||
    !approvalId ||
    allowedDecisions.length === 0
  ) {
    return null;
  }
  if (targetAuthorKeys.length === 0) {
    return null;
  }
  const route =
    params.route.deliveryMode === "target"
      ? ({
          deliveryMode: "target",
          to: params.route.to,
          ...(normalizeOptionalString(params.route.accountId)
            ? { accountId: normalizeOptionalString(params.route.accountId) }
            : {}),
          ...(normalizeOptionalString(params.route.agentId)
            ? { agentId: normalizeOptionalString(params.route.agentId) }
            : {}),
          ...(normalizeOptionalString(params.route.sessionKey)
            ? { sessionKey: normalizeOptionalString(params.route.sessionKey) }
            : {}),
        } satisfies SignalApprovalReactionRoute)
      : ({
          deliveryMode: "session",
          ...(normalizeOptionalString(params.route.agentId)
            ? { agentId: normalizeOptionalString(params.route.agentId) }
            : {}),
          ...(normalizeOptionalString(params.route.sessionKey)
            ? { sessionKey: normalizeOptionalString(params.route.sessionKey) }
            : {}),
        } satisfies SignalApprovalReactionRoute);
  const target: SignalApprovalReactionTarget = {
    approvalId,
    approvalKind: params.approvalKind,
    allowedDecisions,
    targetAuthorKeys,
    route,
  };
  signalApprovalReactionTargets.register(key, target, { ttlMs: params.ttlMs });
  return target;
}

function formatSignalApprovalTerminalTruth(approval: ApprovalResolveResult["approval"]): string {
  const decision = "decision" in approval ? ` decision=${approval.decision}` : "";
  return `status=${approval.status}${decision}`;
}

export function addSignalApprovalReactionHintToStructuredPayload(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  to: string;
  payload: ReplyPayload;
  targetAuthor?: string | null;
  targetAuthorUuid?: string | null;
}): ReplyPayload | null {
  const metadata = getExecApprovalReplyMetadata(params.payload);
  if (!metadata?.allowedDecisions || metadata.allowedDecisions.length === 0) {
    return null;
  }
  if (resolveSignalApprovalTargetAuthorKeys(params).length === 0) {
    return null;
  }
  if (!hasSignalApprovalReactionApprovers({ cfg: params.cfg, accountId: params.accountId })) {
    return null;
  }
  const route = buildTargetRoute({
    cfg: params.cfg,
    accountId: params.accountId,
    to: params.to,
    approvalKind: metadata.approvalKind,
    agentId: metadata.agentId,
    sessionKey: metadata.sessionKey,
  });
  if (!route || !params.payload.text) {
    return null;
  }
  return {
    ...params.payload,
    text: addApprovalReactionHintToText({
      text: params.payload.text,
      allowedDecisions: metadata.allowedDecisions,
    }),
  };
}

function readSignalDeliveryVisibleText(result: SignalApprovalDeliveryResult): string | null {
  const visibleText = result.meta?.signalVisibleText ?? result.meta?.visibleText;
  return typeof visibleText === "string" ? visibleText : null;
}

function listDeliveredSignalMessageIdsWithVisibleHint(params: {
  payload: ReplyPayload;
  results: readonly SignalApprovalDeliveryResult[];
}): string[] {
  const signalResults = params.results.filter(
    (result) => !result.channel || normalizeLowercaseStringOrEmpty(result.channel) === "signal",
  );
  const resultsWithVisibleText = signalResults.filter(
    (result) => readSignalDeliveryVisibleText(result) !== null,
  );
  const candidates = resultsWithVisibleText.length > 0 ? resultsWithVisibleText : signalResults;
  if (resultsWithVisibleText.length === 0 && candidates.length !== 1) {
    return [];
  }
  const ids = candidates
    .filter((result) =>
      resultsWithVisibleText.length > 0
        ? hasApprovalReactionHintText(readSignalDeliveryVisibleText(result))
        : hasApprovalReactionHintText(params.payload.text),
    )
    .map((result) => normalizeOptionalString(result.messageId))
    .filter((messageId): messageId is string => Boolean(messageId && messageId !== "unknown"));
  return Array.from(new Set(ids));
}

export function registerSignalApprovalReactionTargetForDeliveredPayload(params: {
  cfg: OpenClawConfig;
  target: SignalApprovalDeliveryTarget;
  payload: ReplyPayload;
  results: readonly SignalApprovalDeliveryResult[];
  targetAuthor?: string | null;
  targetAuthorUuid?: string | null;
  ttlMs?: number;
}): boolean {
  if (normalizeLowercaseStringOrEmpty(params.target.channel) !== "signal") {
    return false;
  }
  const metadata = getExecApprovalReplyMetadata(params.payload);
  if (!metadata?.allowedDecisions || metadata.allowedDecisions.length === 0) {
    return false;
  }
  if (!hasApprovalReactionHintText(params.payload.text)) {
    return false;
  }
  if (
    !hasSignalApprovalReactionApprovers({ cfg: params.cfg, accountId: params.target.accountId })
  ) {
    return false;
  }
  const conversationKey = resolveSignalDeliveredConversationKey({
    cfg: params.cfg,
    accountId: params.target.accountId,
    to: params.target.to,
  });
  if (!conversationKey) {
    return false;
  }
  const route = buildTargetRoute({
    cfg: params.cfg,
    accountId: params.target.accountId,
    to: params.target.to,
    approvalKind: metadata.approvalKind,
    agentId: metadata.agentId,
    sessionKey: metadata.sessionKey,
  });
  if (!route) {
    return false;
  }
  const targetAuthorKeys = resolveSignalApprovalTargetAuthorKeys(params);
  if (targetAuthorKeys.length === 0) {
    return false;
  }
  let registered = false;
  for (const messageId of listDeliveredSignalMessageIdsWithVisibleHint({
    payload: params.payload,
    results: params.results,
  })) {
    registered =
      Boolean(
        registerSignalApprovalReactionTarget({
          accountId: normalizeAccountId(params.target.accountId ?? undefined),
          conversationKey,
          messageId,
          approvalId: metadata.approvalId,
          approvalKind: metadata.approvalKind,
          allowedDecisions: metadata.allowedDecisions,
          targetAuthorKeys,
          route,
          routeAllowed: true,
          ttlMs: params.ttlMs,
        }),
      ) || registered;
  }
  return registered;
}

export function unregisterSignalApprovalReactionTarget(params: {
  accountId: string;
  conversationKey: string;
  messageId: string;
}): void {
  const key = buildReactionTargetKey(params);
  if (!key) {
    return;
  }
  signalApprovalReactionTargets.delete(key);
}

function resolveTarget(params: {
  target: SignalApprovalReactionTarget | null | undefined;
  reactionKey: string;
  targetAuthorKeys: readonly string[];
}): SignalApprovalReactionResolution | null {
  const target = params.target;
  if (!target) {
    return null;
  }
  if (
    params.targetAuthorKeys.length === 0 ||
    !params.targetAuthorKeys.some((key) => target.targetAuthorKeys.includes(key))
  ) {
    return null;
  }
  const resolved = resolveTypedApprovalReactionTarget<SignalApprovalReactionRoute>({
    target,
    reactionKey: params.reactionKey,
  });
  if (!resolved?.route) {
    return null;
  }
  return {
    approvalId: resolved.approvalId,
    approvalKind: resolved.approvalKind,
    decision: resolved.decision,
    route: resolved.route,
  };
}

export async function resolveSignalApprovalReactionTargetWithPersistence(params: {
  accountId: string;
  conversationKey: string;
  messageId: string;
  reactionKey: string;
  targetAuthor?: string | null;
  targetAuthorUuid?: string | null;
}): Promise<SignalApprovalReactionResolution | null> {
  const key = buildReactionTargetKey(params);
  if (!key) {
    return null;
  }
  const targetAuthorKeys = resolveSignalApprovalTargetAuthorKeys(params);
  if (targetAuthorKeys.length === 0) {
    return null;
  }
  return resolveTarget({
    target: await signalApprovalReactionTargets.lookup(key),
    reactionKey: params.reactionKey,
    targetAuthorKeys,
  });
}

export async function maybeResolveSignalApprovalReaction(params: {
  cfg: OpenClawConfig;
  accountId: string;
  conversationKey: string;
  messageId: string;
  reactionKey: string;
  actorId?: string | null;
  targetAuthor?: string | null;
  targetAuthorUuid?: string | null;
  gatewayUrl?: string;
  logVerboseMessage?: (message: string) => void;
}): Promise<boolean> {
  const target = await resolveSignalApprovalReactionTargetWithPersistence({
    accountId: params.accountId,
    conversationKey: params.conversationKey,
    messageId: params.messageId,
    reactionKey: params.reactionKey,
    targetAuthor: params.targetAuthor,
    targetAuthorUuid: params.targetAuthorUuid,
  });
  if (!target) {
    return false;
  }

  if (!isSignalApprovalReactionRouteStillEnabled({ cfg: params.cfg, target })) {
    params.logVerboseMessage?.(
      `signal: approval reaction denied id=${target.approvalId}; approval route is no longer enabled`,
    );
    return true;
  }

  const actorId = params.actorId?.trim();
  if (!actorId) {
    params.logVerboseMessage?.(
      `signal: approval reaction ignored for ${target.approvalId}; missing actor identity`,
    );
    return true;
  }

  const approvers = getSignalApprovalApprovers({ cfg: params.cfg, accountId: params.accountId });
  if (approvers.length === 0) {
    params.logVerboseMessage?.(
      `signal: approval reaction denied id=${target.approvalId}; reactions require explicit approvers`,
    );
    return true;
  }
  const auth = signalApprovalAuth.authorizeActorAction({
    cfg: params.cfg,
    accountId: params.accountId,
    senderId: actorId,
    action: "approve",
    approvalKind: target.approvalKind,
  });
  if (!auth.authorized) {
    params.logVerboseMessage?.(
      `signal: approval reaction denied id=${target.approvalId} sender=${actorId}`,
    );
    return true;
  }

  const resolveApprovalOverGateway = await loadResolveApprovalOverGateway();
  try {
    const result = await resolveApprovalOverGateway({
      cfg: params.cfg,
      approvalId: target.approvalId,
      approvalKind: target.approvalKind,
      decision: target.decision,
      channel: "signal",
      accountId: params.accountId,
      senderId: actorId,
      gatewayUrl: params.gatewayUrl,
    });
    const terminalTruth = formatSignalApprovalTerminalTruth(result.approval);
    unregisterSignalApprovalReactionTarget({
      accountId: params.accountId,
      conversationKey: params.conversationKey,
      messageId: params.messageId,
    });
    if (!result.applied) {
      params.logVerboseMessage?.(
        `signal: approval reaction already resolved id=${target.approvalId} sender=${actorId} ${terminalTruth}`,
      );
      return true;
    }
    params.logVerboseMessage?.(
      `signal: approval reaction resolved id=${target.approvalId} sender=${actorId} ${terminalTruth}`,
    );
    return true;
  } catch (error) {
    if (isApprovalNotFoundError(error)) {
      unregisterSignalApprovalReactionTarget({
        accountId: params.accountId,
        conversationKey: params.conversationKey,
        messageId: params.messageId,
      });
      params.logVerboseMessage?.(
        `signal: approval reaction ignored for expired approval id=${target.approvalId} sender=${actorId}`,
      );
      return true;
    }
    params.logVerboseMessage?.(
      `signal: approval reaction failed id=${target.approvalId} sender=${actorId}: ${String(error)}`,
    );
    throw error;
  }
}

export function clearSignalApprovalReactionTargetsForTest(): void {
  signalApprovalReactionTargets.clearForTest();
  loadResolveApprovalOverGateway.clear();
}
