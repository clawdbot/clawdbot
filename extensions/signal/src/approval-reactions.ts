// Signal plugin module implements approval reactions behavior.
import { matchesApprovalRequestFilters } from "openclaw/plugin-sdk/approval-client-runtime";
import type { ApprovalResolveResult } from "openclaw/plugin-sdk/approval-gateway-runtime";
import {
  addApprovalReactionHintToText,
  buildApprovalReactionHint,
  createApprovalReactionTargetStore,
  hasApprovalReactionHintText,
  listApprovalReactionBindings,
  resolveTypedApprovalReactionTarget,
  type ApprovalReactionDecisionBinding,
  type ApprovalReactionTargetRecord,
} from "openclaw/plugin-sdk/approval-reaction-runtime";
import {
  getExecApprovalReplyMetadata,
  type ExecApprovalReplyDecision,
} from "openclaw/plugin-sdk/approval-reply-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { normalizeAccountId } from "openclaw/plugin-sdk/routing";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeE164 } from "openclaw/plugin-sdk/text-utility-runtime";
import { resolveSignalTarget } from "./aliases.js";
import { getSignalApprovalApprovers, signalApprovalAuth } from "./approval-auth.js";
import { looksLikeUuid } from "./identity.js";
import { normalizeSignalMessagingTarget } from "./normalize.js";
import { getOptionalSignalRuntime } from "./runtime.js";

const PERSISTENT_NAMESPACE = "signal.approval-reactions.v2";
const PERSISTENT_MAX_ENTRIES = 1000;
const DEFAULT_REACTION_TARGET_TTL_MS = 24 * 60 * 60 * 1000;

type SignalApprovalReactionBinding = ApprovalReactionDecisionBinding;

type SignalApprovalReactionResolution = {
  approvalId: string;
  approvalKind: ApprovalKind;
  decision: ExecApprovalReplyDecision;
  route: SignalApprovalReactionRoute;
};

type ApprovalKind = "exec" | "plugin";
type ApprovalForwardingConfig = NonNullable<NonNullable<OpenClawConfig["approvals"]>["exec"]>;
type ApprovalForwardingMode = NonNullable<ApprovalForwardingConfig["mode"]>;

type SignalApprovalReactionRoute =
  | {
      deliveryMode: "session";
      agentId?: string;
      sessionKey?: string;
    }
  | {
      deliveryMode: "target";
      to: string;
      accountId?: string;
      agentId?: string;
      sessionKey?: string;
    };

type SignalApprovalReactionTarget = ApprovalReactionTargetRecord<SignalApprovalReactionRoute> & {
  approvalKind: ApprovalKind;
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

const resolverRuntimeLoader = createLazyRuntimeModule(() => import("./approval-resolver.js"));

const signalApprovalReactionTargets =
  createApprovalReactionTargetStore<SignalApprovalReactionTarget>({
    namespace: PERSISTENT_NAMESPACE,
    maxEntries: PERSISTENT_MAX_ENTRIES,
    defaultTtlMs: DEFAULT_REACTION_TARGET_TTL_MS,
    openStore: (storeParams) => getOptionalSignalRuntime()?.state.openKeyedStore(storeParams),
    logPersistentError: reportPersistentApprovalReactionError,
    readPersistedTarget,
  });

const loadApprovalResolver = resolverRuntimeLoader;

function resolveApprovalForwardingConfig(params: {
  cfg: OpenClawConfig;
  approvalKind: ApprovalKind;
}): ApprovalForwardingConfig | undefined {
  return params.approvalKind === "plugin"
    ? params.cfg.approvals?.plugin
    : params.cfg.approvals?.exec;
}

function normalizeApprovalForwardingMode(
  mode: ApprovalForwardingConfig["mode"] | undefined,
): ApprovalForwardingMode {
  return mode ?? "session";
}

function approvalModeIncludesSession(mode: ApprovalForwardingMode): boolean {
  return mode === "session" || mode === "both";
}

function approvalModeIncludesTargets(mode: ApprovalForwardingMode): boolean {
  return mode === "targets" || mode === "both";
}

function matchesSignalApprovalReactionFilters(params: {
  config: ApprovalForwardingConfig;
  route: Pick<SignalApprovalReactionRoute, "agentId" | "sessionKey">;
}): boolean {
  return matchesApprovalRequestFilters({
    request: {
      agentId: params.route.agentId,
      sessionKey: params.route.sessionKey,
    },
    agentFilter: params.config.agentFilter,
    sessionFilter: params.config.sessionFilter,
    fallbackAgentIdFromSessionKey: true,
  });
}

function targetAccountMatches(params: {
  routeAccountId?: string | null;
  configuredAccountId?: string | null;
}): boolean {
  const configuredAccountId = normalizeOptionalString(params.configuredAccountId);
  if (!configuredAccountId) {
    return true;
  }
  const routeAccountId = normalizeOptionalString(params.routeAccountId);
  return Boolean(
    routeAccountId &&
    normalizeAccountId(routeAccountId) === normalizeAccountId(configuredAccountId),
  );
}

function resolveSignalApprovalRouteTarget(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  to: string;
}): string | null {
  try {
    return (
      resolveSignalTarget({
        cfg: params.cfg,
        accountId: params.accountId,
        input: params.to,
      })?.to ??
      normalizeSignalMessagingTarget(params.to) ??
      null
    );
  } catch {
    return null;
  }
}

function hasMatchingSignalApprovalReactionTarget(params: {
  cfg: OpenClawConfig;
  config: ApprovalForwardingConfig;
  route: Extract<SignalApprovalReactionRoute, { deliveryMode: "target" }>;
}): boolean {
  return (params.config.targets ?? []).some((target) => {
    if (normalizeLowercaseStringOrEmpty(target.channel) !== "signal") {
      return false;
    }
    const configuredTo = resolveSignalApprovalRouteTarget({
      cfg: params.cfg,
      accountId: target.accountId ?? params.route.accountId,
      to: target.to,
    });
    if (!configuredTo || configuredTo !== params.route.to) {
      return false;
    }
    return targetAccountMatches({
      routeAccountId: params.route.accountId,
      configuredAccountId: target.accountId,
    });
  });
}

function isSignalApprovalReactionRouteStillEnabled(params: {
  cfg: OpenClawConfig;
  target: Pick<SignalApprovalReactionTarget, "approvalKind" | "route">;
}): boolean {
  const config = resolveApprovalForwardingConfig({
    cfg: params.cfg,
    approvalKind: params.target.approvalKind,
  });
  if (!config?.enabled) {
    return false;
  }
  const mode = normalizeApprovalForwardingMode(config.mode);
  if (params.target.route.deliveryMode === "target") {
    return (
      approvalModeIncludesTargets(mode) &&
      matchesSignalApprovalReactionFilters({ config, route: params.target.route }) &&
      hasMatchingSignalApprovalReactionTarget({
        cfg: params.cfg,
        config,
        route: params.target.route,
      })
    );
  }
  if (!approvalModeIncludesSession(mode)) {
    return false;
  }
  return matchesSignalApprovalReactionFilters({ config, route: params.target.route });
}

export function resolveSignalApprovalConversationKey(to: string): string | null {
  return normalizeSignalMessagingTarget(to) ?? null;
}

function resolveSignalApprovalConversationKeyForDeliveredTarget(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  to: string;
}): string | null {
  try {
    return (
      resolveSignalTarget({
        cfg: params.cfg,
        accountId: params.accountId,
        input: params.to,
      })?.to ?? resolveSignalApprovalConversationKey(params.to)
    );
  } catch {
    return resolveSignalApprovalConversationKey(params.to);
  }
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

function reportPersistentApprovalReactionError(error: unknown): void {
  try {
    getOptionalSignalRuntime()
      ?.logging.getChildLogger({ plugin: "signal", feature: "approval-reaction-state" })
      .warn("Signal persistent approval reaction state failed", { error: String(error) });
  } catch {
    // Best effort only: persistent state must never break Signal reactions.
  }
}

function readPersistedTarget(target: unknown): SignalApprovalReactionTarget | null {
  const value = target as Partial<SignalApprovalReactionTarget> | null | undefined;
  if (
    !value ||
    typeof value.approvalId !== "string" ||
    (value.approvalKind !== "exec" && value.approvalKind !== "plugin") ||
    !value.route ||
    (value.route.deliveryMode !== "session" && value.route.deliveryMode !== "target") ||
    !Array.isArray(value.targetAuthorKeys) ||
    !Array.isArray(value.allowedDecisions)
  ) {
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
    allowedDecisions: value.allowedDecisions,
    targetAuthorKeys: value.targetAuthorKeys,
    route,
  };
}

function listSignalApprovalReactionBindings(
  allowedDecisions: readonly ExecApprovalReplyDecision[],
): SignalApprovalReactionBinding[] {
  return listApprovalReactionBindings({ allowedDecisions });
}

export function buildSignalApprovalReactionHint(
  allowedDecisions: readonly ExecApprovalReplyDecision[],
): string | null {
  return buildApprovalReactionHint({ allowedDecisions });
}

export function addSignalApprovalReactionHintToText(params: {
  text: string;
  allowedDecisions: readonly ExecApprovalReplyDecision[];
}): string {
  return addApprovalReactionHintToText(params);
}

function resolveStandaloneApprovalPromptKind(text: string): ApprovalKind | null {
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (/^(?:🔒\s*)?Exec approval required$/.test(firstLine ?? "")) {
    return "exec";
  }
  if (/^(?:(?:🛡️|🛡|🚨|ℹ️|ℹ)\s*)?Plugin approval required$/.test(firstLine ?? "")) {
    return "plugin";
  }
  return null;
}

function isStandaloneApprovalPromptText(text: string): boolean {
  return resolveStandaloneApprovalPromptKind(text) !== null;
}

function normalizeApprovalDecision(value: string): ExecApprovalReplyDecision | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "always") {
    return "allow-always";
  }
  if (normalized === "allow-once" || normalized === "allow-always" || normalized === "deny") {
    return normalized;
  }
  return null;
}

const APPROVAL_ID_LINE_RE = /^\s*ID:\s*([A-Za-z0-9][A-Za-z0-9._:-]*)\s*$/i;
const APPROVE_REPLY_COMMAND_LINE_RE =
  /^\s*Reply with:\s*\/approve(?:@[^\s]+)?\s+([A-Za-z0-9][A-Za-z0-9._:-]*)\s+(.+)$/i;

function extractSignalApprovalPromptBinding(text: string): {
  approvalId: string;
  approvalKind: ApprovalKind;
  allowedDecisions: ExecApprovalReplyDecision[];
} | null {
  const lines = text.split(/\r?\n/);
  const idHeaderMatch = lines
    .map((line) => line.match(APPROVAL_ID_LINE_RE))
    .find((match): match is RegExpMatchArray => Boolean(match));
  if (!idHeaderMatch) {
    return null;
  }
  const approvalId = idHeaderMatch[1];
  if (!approvalId) {
    return null;
  }
  const approvalKind = resolveStandaloneApprovalPromptKind(text);
  if (!approvalKind) {
    return null;
  }
  const allowedDecisions: ExecApprovalReplyDecision[] = [];
  for (const line of lines) {
    const match = line.match(APPROVE_REPLY_COMMAND_LINE_RE);
    const commandApprovalId = match?.[1];
    const decisionList = match?.[2];
    if (commandApprovalId !== approvalId || !decisionList) {
      continue;
    }
    for (const decisionText of decisionList.split(/[\s|,]+/)) {
      const decision = normalizeApprovalDecision(decisionText);
      if (decision && !allowedDecisions.includes(decision)) {
        allowedDecisions.push(decision);
      }
    }
  }
  return allowedDecisions.length > 0 ? { approvalId, approvalKind, allowedDecisions } : null;
}

function buildTargetRoute(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  to: string;
  approvalId: string;
  approvalKind: ApprovalKind;
  agentId?: string | null;
  sessionKey?: string | null;
}): Extract<SignalApprovalReactionRoute, { deliveryMode: "target" }> | null {
  const to = resolveSignalApprovalRouteTarget({
    cfg: params.cfg,
    accountId: params.accountId,
    to: params.to,
  });
  if (!to) {
    return null;
  }
  const route: Extract<SignalApprovalReactionRoute, { deliveryMode: "target" }> = {
    deliveryMode: "target",
    to,
    ...(normalizeOptionalString(params.accountId)
      ? { accountId: normalizeOptionalString(params.accountId) }
      : {}),
    ...(normalizeOptionalString(params.agentId)
      ? { agentId: normalizeOptionalString(params.agentId) }
      : {}),
    ...(normalizeOptionalString(params.sessionKey)
      ? { sessionKey: normalizeOptionalString(params.sessionKey) }
      : {}),
  };
  return isSignalApprovalReactionRouteStillEnabled({
    cfg: params.cfg,
    target: {
      approvalKind: params.approvalKind,
      route,
    },
  })
    ? route
    : null;
}

function shouldAppendSignalApprovalReactionHintForOutboundMessage(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  to: string;
  text: string;
  targetAuthor?: string | null;
  targetAuthorUuid?: string | null;
  agentId?: string | null;
  sessionKey?: string | null;
}): boolean {
  const binding = extractSignalApprovalPromptBinding(params.text);
  if (!binding) {
    return false;
  }
  if (resolveSignalApprovalTargetAuthorKeys(params).length === 0) {
    return false;
  }
  if (!hasSignalApprovalReactionApprovers({ cfg: params.cfg, accountId: params.accountId })) {
    return false;
  }
  return Boolean(
    buildTargetRoute({
      cfg: params.cfg,
      accountId: params.accountId,
      to: params.to,
      approvalId: binding.approvalId,
      approvalKind: binding.approvalKind,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
    }),
  );
}

export function appendSignalApprovalReactionHintForOutboundMessage(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  to: string;
  text: string;
  targetAuthor?: string | null;
  targetAuthorUuid?: string | null;
  agentId?: string | null;
  sessionKey?: string | null;
}): string {
  if (!isStandaloneApprovalPromptText(params.text)) {
    return params.text;
  }
  const binding = extractSignalApprovalPromptBinding(params.text);
  if (
    !binding ||
    !shouldAppendSignalApprovalReactionHintForOutboundMessage({
      ...params,
      text: params.text,
    })
  ) {
    return params.text;
  }
  return addSignalApprovalReactionHintToText({
    text: params.text,
    allowedDecisions: binding.allowedDecisions,
  });
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
  approvalKind: ApprovalKind;
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
  const allowedDecisions = listSignalApprovalReactionBindings(params.allowedDecisions).map(
    (binding) => binding.decision,
  );
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
    approvalId: metadata.approvalId,
    approvalKind: metadata.approvalKind,
    agentId: metadata.agentId,
    sessionKey: metadata.sessionKey,
  });
  if (!route || !params.payload.text) {
    return null;
  }
  return {
    ...params.payload,
    text: addSignalApprovalReactionHintToText({
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
  const conversationKey = resolveSignalApprovalConversationKeyForDeliveredTarget({
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
    approvalId: metadata.approvalId,
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

export function registerSignalApprovalReactionTargetForOutboundMessage(params: {
  cfg: OpenClawConfig;
  accountId: string;
  to: string;
  messageId: string;
  text: string;
  targetAuthor?: string | null;
  targetAuthorUuid?: string | null;
  agentId?: string | null;
  sessionKey?: string | null;
  ttlMs?: number;
}): boolean {
  if (!isStandaloneApprovalPromptText(params.text)) {
    return false;
  }
  const binding = extractSignalApprovalPromptBinding(params.text);
  if (!binding) {
    return false;
  }
  if (!hasSignalApprovalReactionApprovers({ cfg: params.cfg, accountId: params.accountId })) {
    return false;
  }
  const targetAuthorKeys = resolveSignalApprovalTargetAuthorKeys(params);
  if (targetAuthorKeys.length === 0) {
    return false;
  }
  const conversationKey = resolveSignalApprovalConversationKey(params.to);
  if (!conversationKey) {
    return false;
  }
  const route = buildTargetRoute({
    cfg: params.cfg,
    accountId: params.accountId,
    to: params.to,
    approvalId: binding.approvalId,
    approvalKind: binding.approvalKind,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  });
  if (!route) {
    return false;
  }
  return Boolean(
    registerSignalApprovalReactionTarget({
      accountId: params.accountId,
      conversationKey,
      messageId: params.messageId,
      approvalId: binding.approvalId,
      approvalKind: binding.approvalKind,
      allowedDecisions: binding.allowedDecisions,
      targetAuthorKeys,
      route,
      routeAllowed: true,
      ttlMs: params.ttlMs,
    }),
  );
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

  const { isApprovalNotFoundError, resolveSignalApproval } = await loadApprovalResolver();
  try {
    const result = await resolveSignalApproval({
      cfg: params.cfg,
      approvalId: target.approvalId,
      approvalKind: target.approvalKind,
      decision: target.decision,
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
    return true;
  }
}

export function clearSignalApprovalReactionTargetsForTest(): void {
  signalApprovalReactionTargets.clearForTest();
  resolverRuntimeLoader.clear();
}
