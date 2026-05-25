import type { ExecApprovalReplyDecision } from "openclaw/plugin-sdk/approval-reply-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { getIMessageApprovalApprovers, imessageApprovalAuth } from "./approval-auth.js";
import { resolveIMessageReactionContext } from "./monitor/reaction-context.js";
import type { IMessagePayload } from "./monitor/types.js";
import { getOptionalIMessageRuntime } from "./runtime.js";
import { normalizeIMessageHandle } from "./targets.js";

const IMESSAGE_APPROVAL_REACTION_META = {
  "allow-once": {
    emoji: "👍",
    label: "Allow Once",
  },
  deny: {
    emoji: "👎",
    label: "Deny",
  },
} satisfies Partial<Record<ExecApprovalReplyDecision, { emoji: string; label: string }>>;

const IMESSAGE_APPROVAL_REACTION_ORDER = [
  "allow-once",
  "deny",
] as const satisfies readonly ExecApprovalReplyDecision[];

const PERSISTENT_NAMESPACE = "imessage.approval-reactions";
const PERSISTENT_MAX_ENTRIES = 1000;
const DEFAULT_REACTION_TARGET_TTL_MS = 24 * 60 * 60 * 1000;

export type IMessageApprovalReactionBinding = {
  decision: ExecApprovalReplyDecision;
  emoji: string;
  label: string;
};

type IMessageApprovalReactionResolution = {
  approvalId: string;
  decision: ExecApprovalReplyDecision;
};

type IMessageApprovalReactionTarget = {
  approvalId: string;
  allowedDecisions: readonly ExecApprovalReplyDecision[];
};

type PersistedIMessageApprovalReactionTarget = {
  version: 1;
  target: IMessageApprovalReactionTarget;
};

type IMessageApprovalReactionStore = {
  register(
    key: string,
    value: PersistedIMessageApprovalReactionTarget,
    opts?: { ttlMs?: number },
  ): Promise<void>;
  lookup(key: string): Promise<PersistedIMessageApprovalReactionTarget | undefined>;
  delete(key: string): Promise<boolean>;
};

export type IMessageApprovalConversationKey = {
  chatGuid?: string;
  chatIdentifier?: string;
  chatId?: number | string;
  /** Direct-message handle (already normalized via normalizeIMessageHandle). */
  handle?: string;
};

type InMemoryReactionEntry = {
  target: IMessageApprovalReactionTarget;
  expiresAtMs: number;
};

const imessageApprovalReactionTargets = new Map<string, InMemoryReactionEntry>();
let persistentStore: IMessageApprovalReactionStore | undefined;
let persistentStoreDisabled = false;
let resolverRuntimePromise: Promise<typeof import("./approval-resolver.js")> | undefined;

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

function reportPersistentApprovalReactionError(error: unknown): void {
  try {
    getOptionalIMessageRuntime()
      ?.logging.getChildLogger({ plugin: "imessage", feature: "approval-reaction-state" })
      .warn("iMessage persistent approval reaction state failed", { error: String(error) });
  } catch {
    // Best effort only: persistent state must never break iMessage reactions.
  }
}

function disablePersistentApprovalReactionStore(error: unknown): void {
  persistentStoreDisabled = true;
  persistentStore = undefined;
  reportPersistentApprovalReactionError(error);
}

function getPersistentApprovalReactionStore(): IMessageApprovalReactionStore | undefined {
  if (persistentStoreDisabled) {
    return undefined;
  }
  if (persistentStore) {
    return persistentStore;
  }
  const runtime = getOptionalIMessageRuntime();
  if (!runtime) {
    return undefined;
  }
  try {
    persistentStore = runtime.state.openKeyedStore<PersistedIMessageApprovalReactionTarget>({
      namespace: PERSISTENT_NAMESPACE,
      maxEntries: PERSISTENT_MAX_ENTRIES,
      defaultTtlMs: DEFAULT_REACTION_TARGET_TTL_MS,
    });
    return persistentStore;
  } catch (error) {
    disablePersistentApprovalReactionStore(error);
    return undefined;
  }
}

function readPersistedTarget(value: unknown): IMessageApprovalReactionTarget | null {
  const persisted = value as PersistedIMessageApprovalReactionTarget | undefined;
  if (
    persisted?.version !== 1 ||
    !persisted.target ||
    typeof persisted.target.approvalId !== "string" ||
    !Array.isArray(persisted.target.allowedDecisions)
  ) {
    return null;
  }
  return persisted.target;
}

function rememberPersistentApprovalReactionTarget(params: {
  key: string;
  target: IMessageApprovalReactionTarget;
  ttlMs?: number;
}): void {
  const ttlMs = params.ttlMs == null ? DEFAULT_REACTION_TARGET_TTL_MS : Math.max(1, params.ttlMs);
  const store = getPersistentApprovalReactionStore();
  if (!store) {
    return;
  }
  void store
    .register(params.key, { version: 1, target: params.target }, { ttlMs })
    .catch(disablePersistentApprovalReactionStore);
}

function forgetPersistentApprovalReactionTarget(key: string): void {
  const store = getPersistentApprovalReactionStore();
  if (!store) {
    return;
  }
  void store.delete(key).catch(disablePersistentApprovalReactionStore);
}

async function lookupPersistentApprovalReactionTarget(
  key: string,
): Promise<IMessageApprovalReactionTarget | null> {
  const store = getPersistentApprovalReactionStore();
  if (!store) {
    return null;
  }
  try {
    return readPersistedTarget(await store.lookup(key));
  } catch (error) {
    disablePersistentApprovalReactionStore(error);
    return null;
  }
}

export function listIMessageApprovalReactionBindings(
  allowedDecisions: readonly ExecApprovalReplyDecision[],
): IMessageApprovalReactionBinding[] {
  const allowed = new Set(allowedDecisions);
  return IMESSAGE_APPROVAL_REACTION_ORDER.filter((decision) => allowed.has(decision)).map(
    (decision) => ({
      decision,
      emoji: IMESSAGE_APPROVAL_REACTION_META[decision].emoji,
      label: IMESSAGE_APPROVAL_REACTION_META[decision].label,
    }),
  );
}

export function buildIMessageApprovalReactionHint(
  allowedDecisions: readonly ExecApprovalReplyDecision[],
): string | null {
  const bindings = listIMessageApprovalReactionBindings(allowedDecisions);
  if (bindings.length === 0) {
    return null;
  }
  return `React with:\n\n${bindings.map((binding) => `${binding.emoji} ${binding.label}`).join("\n")}`;
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

function resolveIMessageApprovalReactionDecision(
  reactionKey: string,
  allowedDecisions: readonly ExecApprovalReplyDecision[],
): ExecApprovalReplyDecision | null {
  const normalizedReaction = reactionKey.trim();
  if (!normalizedReaction) {
    return null;
  }
  const allowed = new Set(allowedDecisions);
  for (const decision of IMESSAGE_APPROVAL_REACTION_ORDER) {
    if (!allowed.has(decision)) {
      continue;
    }
    if (IMESSAGE_APPROVAL_REACTION_META[decision].emoji === normalizedReaction) {
      return decision;
    }
  }
  return null;
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
  const ttlMs = params.ttlMs == null ? DEFAULT_REACTION_TARGET_TTL_MS : Math.max(1, params.ttlMs);
  const expiresAtMs = Date.now() + ttlMs;
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
    imessageApprovalReactionTargets.set(key, { target, expiresAtMs });
    rememberPersistentApprovalReactionTarget({ key, target, ttlMs });
  }
  pruneExpiredInMemoryReactionTargets();
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
    forgetPersistentApprovalReactionTarget(key);
  }
}

function resolveTarget(params: {
  target: IMessageApprovalReactionTarget | null | undefined;
  reactionKey: string;
}): IMessageApprovalReactionResolution | null {
  const target = params.target;
  if (!target) {
    return null;
  }
  const decision = resolveIMessageApprovalReactionDecision(
    params.reactionKey,
    target.allowedDecisions,
  );
  return decision ? { approvalId: target.approvalId, decision } : null;
}

function lookupInMemoryReactionTarget(key: string): IMessageApprovalReactionTarget | null {
  const entry = imessageApprovalReactionTargets.get(key);
  if (!entry) {
    return null;
  }
  if (entry.expiresAtMs <= Date.now()) {
    imessageApprovalReactionTargets.delete(key);
    return null;
  }
  return entry.target;
}

function pruneExpiredInMemoryReactionTargets(): void {
  const now = Date.now();
  for (const [key, entry] of imessageApprovalReactionTargets) {
    if (entry.expiresAtMs <= now) {
      imessageApprovalReactionTargets.delete(key);
    }
  }
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
    const inMemory = resolveTarget({
      target: lookupInMemoryReactionTarget(key),
      reactionKey: params.reactionKey,
    });
    if (inMemory) {
      return inMemory;
    }
  }
  for (const key of keys) {
    const persisted = resolveTarget({
      target: await lookupPersistentApprovalReactionTarget(key),
      reactionKey: params.reactionKey,
    });
    if (persisted) {
      return persisted;
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
  // Cross-device echo: Apple delivers is_from_me=true rows for the operator's
  // own tapbacks across paired devices. Ignoring them prevents a bot whose
  // own handle is in `allowFrom` (a common dogfooding setup) from
  // self-approving via the operator's reaction on a different Apple device.
  if (message.is_from_me === true) {
    return null;
  }
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

export async function maybeResolveIMessageApprovalReaction(params: {
  cfg: OpenClawConfig;
  accountId: string;
  message: IMessagePayload;
  bodyText: string;
  gatewayUrl?: string;
  logVerboseMessage?: (message: string) => void;
}): Promise<boolean> {
  const event = readApprovalReactionEvent(params.message, params.bodyText);
  if (!event) {
    return false;
  }
  // A removed tapback (user un-taps 👍 or switches to a different emoji) is
  // intentionally NOT a fresh resolve. We only want to clear the binding so
  // the next added-tapback resolves freshly. Falling through to `return false`
  // would surface the un-tap as a noisy reaction system event; instead we
  // own the event and stay quiet.
  if (event.action === "removed") {
    return false;
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
    return false;
  }

  const approvalKind = target.approvalId.startsWith("plugin:") ? "plugin" : "exec";
  const approvers = getIMessageApprovalApprovers({ cfg: params.cfg, accountId: params.accountId });
  if (approvers.length === 0) {
    params.logVerboseMessage?.(
      `imessage: approval reaction denied id=${target.approvalId}; reactions require explicit approvers`,
    );
    return true;
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
    return true;
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
    return true;
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
      return true;
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
    return true;
  }
}

export function clearIMessageApprovalReactionTargetsForTest(): void {
  imessageApprovalReactionTargets.clear();
  persistentStore = undefined;
  persistentStoreDisabled = false;
  resolverRuntimePromise = undefined;
}
