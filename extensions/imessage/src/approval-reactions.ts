import {
  buildApprovalReactionHint,
  createApprovalReactionTargetStore,
  listApprovalReactionBindings,
  resolveApprovalReactionTarget,
  type ApprovalReactionDecisionBinding,
  type ApprovalReactionTargetRecord,
} from "openclaw/plugin-sdk/approval-reaction-runtime";
import type { ExecApprovalReplyDecision } from "openclaw/plugin-sdk/approval-reply-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  asDateTimestampMs,
  isFutureDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "openclaw/plugin-sdk/number-runtime";
import { getIMessageApprovalApprovers, imessageApprovalAuth } from "./approval-auth.js";
import { resolveIMessageReactionContext } from "./monitor/reaction-context.js";
import type { IMessagePayload } from "./monitor/types.js";
import { getOptionalIMessageRuntime } from "./runtime.js";
import { normalizeIMessageHandle } from "./targets.js";

const PERSISTENT_NAMESPACE = "imessage.approval-reactions";
const PERSISTENT_MAX_ENTRIES = 1000;
const DEFAULT_REACTION_TARGET_TTL_MS = 24 * 60 * 60 * 1000;

export type IMessageApprovalReactionBinding = ApprovalReactionDecisionBinding;

type IMessageApprovalReactionResolution = {
  approvalId: string;
  decision: ExecApprovalReplyDecision;
};
export type IMessageApprovalReactionHandleResult =
  | { handled: false; stopPolling: false }
  | { handled: true; stopPolling: boolean };

type IMessageApprovalReactionTarget = ApprovalReactionTargetRecord;

export type IMessageApprovalConversationKey = {
  chatGuid?: string;
  chatIdentifier?: string;
  chatId?: number | string;
  /** Direct-message handle (already normalized via normalizeIMessageHandle). */
  handle?: string;
};

export type PendingIMessageApprovalReactionPollTarget = {
  accountId: string;
  conversation: IMessageApprovalConversationKey;
  messageId: string;
  approvalId: string;
  allowedDecisions: readonly ExecApprovalReplyDecision[];
  expiresAtMs: number;
};

let resolverRuntimePromise: Promise<typeof import("./approval-resolver.js")> | undefined;
const pendingReactionPollTargets = new Map<string, PendingIMessageApprovalReactionPollTarget>();

function loadApprovalResolver(): Promise<typeof import("./approval-resolver.js")> {
  resolverRuntimePromise ??= import("./approval-resolver.js");
  return resolverRuntimePromise;
}

function chatIdToKeyValue(chatId: number | string | undefined): string | null {
  if (chatId == null || chatId === "") {
    return null;
  }
  if (typeof chatId === "number") {
    // chat.db ROWID is always > 0; treat 0 as "missing" rather than a valid key.
    return Number.isFinite(chatId) && chatId > 0 ? String(chatId) : null;
  }
  const value = chatId.trim();
  return value || null;
}

function enumerateConversationKeyForms(conversation: IMessageApprovalConversationKey): string[] {
  const forms: string[] = [];
  const chatGuid = conversation.chatGuid?.trim();
  if (chatGuid) {
    forms.push(`chat_guid:${chatGuid}`);
  }
  const chatIdentifier = conversation.chatIdentifier?.trim();
  if (chatIdentifier) {
    forms.push(`chat_identifier:${chatIdentifier}`);
  }
  const chatIdValue = chatIdToKeyValue(conversation.chatId);
  if (chatIdValue) {
    forms.push(`chat_id:${chatIdValue}`);
  }
  const handle = conversation.handle?.trim();
  if (handle) {
    forms.push(`handle:${handle}`);
  }
  return forms;
}

function normalizeConversationKey(
  conversation: IMessageApprovalConversationKey,
): string | undefined {
  return enumerateConversationKeyForms(conversation)[0];
}

function enumerateReactionTargetKeys(params: {
  accountId: string;
  conversation: IMessageApprovalConversationKey;
  messageId: string;
}): string[] {
  const accountId = params.accountId.trim();
  const messageId = params.messageId.trim();
  if (!accountId || !messageId) {
    return [];
  }
  return enumerateConversationKeyForms(params.conversation).map(
    (form) => `${accountId}:${form}:${messageId}`,
  );
}

function prunePendingReactionPollTargets(nowMs = Date.now()): void {
  for (const [key, target] of pendingReactionPollTargets.entries()) {
    if (!isFutureDateTimestampMs(target.expiresAtMs, { nowMs })) {
      pendingReactionPollTargets.delete(key);
    }
  }
}

function resolvePendingReactionPollExpiry(
  ttlMs: number | undefined,
): { ttlMs: number; expiresAtMs: number } | undefined {
  const nowMs = asDateTimestampMs(Date.now());
  if (nowMs === undefined) {
    return undefined;
  }
  const expiresAtMs =
    resolveExpiresAtMsFromDurationMs(ttlMs ?? DEFAULT_REACTION_TARGET_TTL_MS, { nowMs }) ??
    resolveExpiresAtMsFromDurationMs(DEFAULT_REACTION_TARGET_TTL_MS, { nowMs });
  if (expiresAtMs === undefined) {
    return undefined;
  }
  return {
    ttlMs: expiresAtMs - nowMs,
    expiresAtMs,
  };
}

function normalizePollTargetMessageId(messageId: string): string {
  return messageId.trim().replace(/^p:\d+\//iu, "");
}

function mergePollTargetConversation(
  left: IMessageApprovalConversationKey,
  right: IMessageApprovalConversationKey,
): IMessageApprovalConversationKey {
  return {
    chatGuid: left.chatGuid ?? right.chatGuid,
    chatIdentifier: left.chatIdentifier ?? right.chatIdentifier,
    chatId: left.chatId ?? right.chatId,
    handle: left.handle ?? right.handle,
  };
}

export function listPendingIMessageApprovalReactionPollTargets(params: {
  accountId: string;
}): PendingIMessageApprovalReactionPollTarget[] {
  const accountId = params.accountId.trim();
  if (!accountId) {
    return [];
  }
  prunePendingReactionPollTargets();
  const targetByApprovalAndMessage = new Map<string, PendingIMessageApprovalReactionPollTarget>();
  for (const target of pendingReactionPollTargets.values()) {
    if (target.accountId !== accountId) {
      continue;
    }
    const key = `${target.approvalId}:${normalizePollTargetMessageId(target.messageId)}`;
    const existing = targetByApprovalAndMessage.get(key);
    if (!existing) {
      targetByApprovalAndMessage.set(key, target);
      continue;
    }
    targetByApprovalAndMessage.set(key, {
      ...existing,
      conversation: mergePollTargetConversation(existing.conversation, target.conversation),
      expiresAtMs: Math.max(existing.expiresAtMs, target.expiresAtMs),
    });
  }
  return [...targetByApprovalAndMessage.values()];
}

function reportPersistentApprovalReactionError(error: unknown): void {
  try {
    getOptionalIMessageRuntime()
      ?.logging.getChildLogger({ plugin: "imessage", feature: "approval-reaction-state" })
      .warn("iMessage persistent approval reaction state failed", { error: String(error) });
  } catch {
    // Best effort only: persistent state must never break iMessage reactions.
  }
}

function readPersistedTarget(value: unknown): IMessageApprovalReactionTarget | null {
  const target = value as Partial<IMessageApprovalReactionTarget> | undefined;
  if (!target || typeof target.approvalId !== "string" || !Array.isArray(target.allowedDecisions)) {
    return null;
  }
  const allowedDecisions = target.allowedDecisions
    .map((valueValue) =>
      typeof valueValue === "string" ? normalizeApprovalDecision(valueValue) : null,
    )
    .filter((valueLocal): valueLocal is ExecApprovalReplyDecision => Boolean(valueLocal));
  if (allowedDecisions.length === 0) {
    return null;
  }
  return {
    approvalId: target.approvalId,
    allowedDecisions,
    ...(target.approvalKind === "exec" || target.approvalKind === "plugin"
      ? { approvalKind: target.approvalKind }
      : {}),
  };
}

const imessageApprovalReactionTargets =
  createApprovalReactionTargetStore<IMessageApprovalReactionTarget>({
    namespace: PERSISTENT_NAMESPACE,
    maxEntries: PERSISTENT_MAX_ENTRIES,
    defaultTtlMs: DEFAULT_REACTION_TARGET_TTL_MS,
    openStore: (params) => getOptionalIMessageRuntime()?.state.openKeyedStore(params),
    logPersistentError: reportPersistentApprovalReactionError,
    readPersistedTarget,
  });

export function listIMessageApprovalReactionBindings(
  allowedDecisions: readonly ExecApprovalReplyDecision[],
): IMessageApprovalReactionBinding[] {
  return listApprovalReactionBindings({ allowedDecisions });
}

export function buildIMessageApprovalReactionHint(
  allowedDecisions: readonly ExecApprovalReplyDecision[],
): string | null {
  return buildApprovalReactionHint({ allowedDecisions });
}

function insertIMessageApprovalReactionHintNearHeader(params: {
  text: string;
  hint: string;
}): string {
  const lines = params.text.split(/\r?\n/);
  const idLineIndex = lines.findIndex((line) => /^ID:\s*\S+/.test(line.trim()));
  if (idLineIndex >= 0) {
    const before = lines.slice(0, idLineIndex + 1).join("\n");
    const after = lines
      .slice(idLineIndex + 1)
      .join("\n")
      .replace(/^\n+/, "");
    return after ? `${before}\n\n${params.hint}\n\n${after}` : `${before}\n\n${params.hint}`;
  }
  return `${params.hint}\n\n${params.text}`;
}

export function addIMessageApprovalReactionHintToText(params: {
  text: string;
  allowedDecisions: readonly ExecApprovalReplyDecision[];
}): string {
  if (/(^|\n)React with:\s*(\n|$)/i.test(params.text)) {
    return params.text;
  }
  const hint = buildIMessageApprovalReactionHint(params.allowedDecisions);
  return hint
    ? insertIMessageApprovalReactionHintNearHeader({ text: params.text, hint })
    : params.text;
}

export function appendIMessageApprovalReactionHintForOutboundMessage(text: string): string {
  if (/(^|\n)React with:\s*(\n|$)/i.test(text)) {
    return text;
  }
  const binding = extractIMessageApprovalPromptBinding(text);
  if (!binding) {
    return text;
  }
  return addIMessageApprovalReactionHintToText({
    text,
    allowedDecisions: binding.allowedDecisions,
  });
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
const APPROVE_COMMAND_LINE_RE = /\/approve(?:@[^\s]+)?\s+([A-Za-z0-9][A-Za-z0-9._:-]*)\s+(.+)$/i;

export function extractIMessageApprovalPromptBinding(text: string): {
  approvalId: string;
  allowedDecisions: ExecApprovalReplyDecision[];
} | null {
  const lines = text.split(/\r?\n/);
  // Only treat as an approval prompt if it carries the canonical "ID: <approvalId>"
  // header that the SDK payload builders emit. This prevents arbitrary outbound
  // text containing `/approve <id> allow-once` (agent help text, quoted docs,
  // pasted snippets) from getting a reaction binding registered against it.
  const idHeaderMatch = lines
    .map((line) => line.match(APPROVAL_ID_LINE_RE))
    .find((match): match is RegExpMatchArray => Boolean(match));
  if (!idHeaderMatch) {
    return null;
  }
  const approvalId = idHeaderMatch[1];
  const allowedDecisions: ExecApprovalReplyDecision[] = [];
  for (const line of lines) {
    const match = line.match(APPROVE_COMMAND_LINE_RE);
    if (!match || match[1] !== approvalId) {
      continue;
    }
    const decisions = match[2].split(/[\s|,]+/);
    for (const decisionText of decisions) {
      const decision = normalizeApprovalDecision(decisionText);
      if (decision && !allowedDecisions.includes(decision)) {
        allowedDecisions.push(decision);
      }
    }
  }
  return allowedDecisions.length > 0 ? { approvalId, allowedDecisions } : null;
}

export function registerIMessageApprovalReactionTarget(params: {
  accountId: string;
  conversation: IMessageApprovalConversationKey;
  messageId: string;
  approvalId: string;
  allowedDecisions: readonly ExecApprovalReplyDecision[];
  ttlMs?: number;
}): IMessageApprovalReactionTarget | null {
  const approvalId = params.approvalId.trim();
  const allowedDecisions = listIMessageApprovalReactionBindings(params.allowedDecisions).map(
    (binding) => binding.decision,
  );
  if (!approvalId || allowedDecisions.length === 0) {
    return null;
  }
  const target = { approvalId, allowedDecisions };
  const expiry = resolvePendingReactionPollExpiry(params.ttlMs);
  if (!expiry) {
    return null;
  }
  // Register the binding under every key we can derive from the conversation
  // (chat_guid / chat_identifier / chat_id / handle). Inbound lookup precedence
  // can differ from outbound — e.g. send only sees `{handle: "+1..."}` for a
  // DM target, while the bridge populates chat_guid on the inbound tapback.
  // Indexing under every available key keeps send/inbound symmetric without
  // forcing the caller to know which key the bridge will pick.
  const keys = enumerateReactionTargetKeys({
    accountId: params.accountId,
    conversation: params.conversation,
    messageId: params.messageId,
  });
  if (keys.length === 0) {
    return null;
  }
  for (const key of keys) {
    imessageApprovalReactionTargets.register(key, target, { ttlMs: expiry.ttlMs });
    pendingReactionPollTargets.set(key, {
      accountId: params.accountId,
      conversation: params.conversation,
      messageId: params.messageId,
      approvalId,
      allowedDecisions,
      expiresAtMs: expiry.expiresAtMs,
    });
  }
  prunePendingReactionPollTargets();
  return target;
}

export function registerIMessageApprovalReactionTargetForOutboundMessage(params: {
  accountId: string;
  conversation: IMessageApprovalConversationKey;
  messageId: string;
  text: string;
  ttlMs?: number;
}): boolean {
  const binding = extractIMessageApprovalPromptBinding(params.text);
  if (!binding) {
    return false;
  }
  return Boolean(
    registerIMessageApprovalReactionTarget({
      accountId: params.accountId,
      conversation: params.conversation,
      messageId: params.messageId,
      approvalId: binding.approvalId,
      allowedDecisions: binding.allowedDecisions,
      ttlMs: params.ttlMs,
    }),
  );
}

export function unregisterIMessageApprovalReactionTarget(params: {
  accountId: string;
  conversation: IMessageApprovalConversationKey;
  messageId: string;
}): void {
  const keys = enumerateReactionTargetKeys(params);
  for (const key of keys) {
    imessageApprovalReactionTargets.delete(key);
    pendingReactionPollTargets.delete(key);
  }
}

function resolveTarget(params: {
  target: IMessageApprovalReactionTarget | null | undefined;
  reactionKey: string;
}): IMessageApprovalReactionResolution | null {
  const target = resolveApprovalReactionTarget(params);
  return target ? { approvalId: target.approvalId, decision: target.decision } : null;
}

export async function resolveIMessageApprovalReactionTargetWithPersistence(params: {
  accountId: string;
  conversation: IMessageApprovalConversationKey;
  messageId: string;
  reactionKey: string;
}): Promise<IMessageApprovalReactionResolution | null> {
  // Try every key we can derive from the inbound payload. Send-side may have
  // registered only `handle:`, while the inbound payload carries chat_guid
  // (the bridge sets chat_guid even for DMs). We probe in precedence order
  // (chat_guid → chat_identifier → chat_id → handle) and accept the first hit.
  const keys = enumerateReactionTargetKeys(params);
  for (const key of keys) {
    const target = resolveTarget({
      target: await imessageApprovalReactionTargets.lookup(key),
      reactionKey: params.reactionKey,
    });
    if (target) {
      return target;
    }
  }
  return null;
}

type IMessageApprovalReactionEvent = {
  conversation: IMessageApprovalConversationKey;
  /** Primary candidate (the normalized targetGuid form). */
  messageId: string;
  /**
   * Every GUID candidate iMessage surfaced for the tapback target. iMessage
   * `reaction.targetGuids` contains both the normalized form (e.g. `abc-123`)
   * and the raw form (e.g. `p:0/abc-123`). The outbound binding may be
   * registered under either form depending on which the imsg bridge returned
   * from `send`, so the lookup must probe all of them.
   */
  messageIdCandidates: readonly string[];
  actorHandle: string;
  reactionKey: string;
  action: "added" | "removed";
};

function readApprovalReactionEvent(
  message: IMessagePayload,
  bodyText: string,
): IMessageApprovalReactionEvent | null {
  const reaction = resolveIMessageReactionContext(message, bodyText);
  if (!reaction) {
    return null;
  }
  const reactionKey = reaction.emoji.trim();
  const candidates = (reaction.targetGuids ?? [])
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const primary = reaction.targetGuid?.trim() || candidates[0] || "";
  const messageIdCandidates = candidates.length > 0 ? candidates : primary ? [primary] : [];
  const actorHandle = normalizeIMessageHandle((message.sender ?? "").trim());
  if (!reactionKey || !primary || !actorHandle) {
    return null;
  }
  const conversation: IMessageApprovalConversationKey = {
    ...(message.chat_guid?.trim() ? { chatGuid: message.chat_guid.trim() } : {}),
    ...(message.chat_identifier?.trim() ? { chatIdentifier: message.chat_identifier.trim() } : {}),
    ...(chatIdToKeyValue(message.chat_id ?? undefined)
      ? { chatId: message.chat_id as number }
      : {}),
    ...(message.is_group ? {} : { handle: actorHandle }),
  };
  if (!normalizeConversationKey(conversation)) {
    return null;
  }
  return {
    conversation,
    messageId: primary,
    messageIdCandidates,
    actorHandle,
    reactionKey,
    action: reaction.action,
  };
}

export async function handleIMessageApprovalReaction(params: {
  cfg: OpenClawConfig;
  accountId: string;
  message: IMessagePayload;
  bodyText: string;
  gatewayUrl?: string;
  logVerboseMessage?: (message: string) => void;
}): Promise<IMessageApprovalReactionHandleResult> {
  const event = readApprovalReactionEvent(params.message, params.bodyText);
  if (!event) {
    return { handled: false, stopPolling: false };
  }
  // A removed tapback (user un-taps 👍 or switches to a different emoji) is
  // intentionally NOT a fresh resolve. We only want to clear the binding so
  // the next added-tapback resolves freshly. Falling through to `return false`
  // would surface the un-tap as a noisy reaction system event; instead we
  // own the event and stay quiet.
  if (event.action === "removed") {
    return { handled: false, stopPolling: false };
  }
  let target: IMessageApprovalReactionResolution | null = null;
  let matchedMessageId: string | null = null;
  for (const candidate of event.messageIdCandidates) {
    target = await resolveIMessageApprovalReactionTargetWithPersistence({
      accountId: params.accountId,
      conversation: event.conversation,
      messageId: candidate,
      reactionKey: event.reactionKey,
    });
    if (target) {
      matchedMessageId = candidate;
      break;
    }
  }
  if (!target) {
    return { handled: false, stopPolling: false };
  }

  const approvalKind = target.approvalId.startsWith("plugin:") ? "plugin" : "exec";
  const approvers = getIMessageApprovalApprovers({ cfg: params.cfg, accountId: params.accountId });
  if (approvers.length === 0) {
    params.logVerboseMessage?.(
      `imessage: approval reaction denied id=${target.approvalId}; reactions require explicit approvers`,
    );
    return { handled: true, stopPolling: false };
  }
  const auth = imessageApprovalAuth.authorizeActorAction({
    cfg: params.cfg,
    accountId: params.accountId,
    senderId: event.actorHandle,
    action: "approve",
    approvalKind,
  });
  if (!auth.authorized) {
    params.logVerboseMessage?.(
      `imessage: approval reaction denied id=${target.approvalId} sender=${event.actorHandle}`,
    );
    return { handled: true, stopPolling: false };
  }

  const { isApprovalNotFoundError, resolveIMessageApproval } = await loadApprovalResolver();
  try {
    await resolveIMessageApproval({
      cfg: params.cfg,
      approvalId: target.approvalId,
      decision: target.decision,
      senderId: event.actorHandle,
      gatewayUrl: params.gatewayUrl,
    });
    // Clear the binding on success so a second tapback (toggle 👍→👎, Apple
    // cross-device echo, or chat.db replay) does not re-fire and produce a
    // misleading 'expired approval' log line. Iterate every GUID candidate the
    // inbound surfaced so the prefixed/unprefixed form pair both get cleared.
    for (const candidate of event.messageIdCandidates) {
      unregisterIMessageApprovalReactionTarget({
        accountId: params.accountId,
        conversation: event.conversation,
        messageId: candidate,
      });
    }
    params.logVerboseMessage?.(
      `imessage: approval reaction resolved id=${target.approvalId} sender=${event.actorHandle} decision=${target.decision} via messageId=${matchedMessageId ?? event.messageId}`,
    );
    return { handled: true, stopPolling: true };
  } catch (error) {
    if (isApprovalNotFoundError(error)) {
      for (const candidate of event.messageIdCandidates) {
        unregisterIMessageApprovalReactionTarget({
          accountId: params.accountId,
          conversation: event.conversation,
          messageId: candidate,
        });
      }
      params.logVerboseMessage?.(
        `imessage: approval reaction ignored for expired approval id=${target.approvalId} sender=${event.actorHandle}`,
      );
      return { handled: true, stopPolling: true };
    }
    // Surface non-NotFound errors at warn level so a gateway 5xx / network
    // outage / auth failure is visible without OPENCLAW_LOG_LEVEL=debug.
    try {
      getOptionalIMessageRuntime()
        ?.logging.getChildLogger({ plugin: "imessage", feature: "approval-reactions" })
        .warn("approval reaction failed", {
          approvalId: target.approvalId,
          senderId: event.actorHandle,
          error: String(error),
        });
    } catch {
      // Logger surface is optional in tests; never let logging mask the error.
    }
    params.logVerboseMessage?.(
      `imessage: approval reaction failed id=${target.approvalId} sender=${event.actorHandle}: ${String(error)}`,
    );
    return { handled: true, stopPolling: true };
  }
}

export async function maybeResolveIMessageApprovalReaction(params: {
  cfg: OpenClawConfig;
  accountId: string;
  message: IMessagePayload;
  bodyText: string;
  gatewayUrl?: string;
  logVerboseMessage?: (message: string) => void;
}): Promise<boolean> {
  return (await handleIMessageApprovalReaction(params)).handled;
}

export function clearIMessageApprovalReactionTargetsForTest(): void {
  imessageApprovalReactionTargets.clearForTest();
  pendingReactionPollTargets.clear();
  resolverRuntimePromise = undefined;
}
