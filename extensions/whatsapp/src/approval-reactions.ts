import type { WAMessage } from "baileys";
import type { ExecApprovalReplyDecision } from "openclaw/plugin-sdk/approval-reply-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { getWhatsAppApprovalApprovers, whatsappApprovalAuth } from "./approval-auth.js";
import { getOptionalWhatsAppRuntime } from "./runtime.js";

const WHATSAPP_APPROVAL_REACTION_META = {
  "allow-once": {
    emoji: "👍",
    label: "Allow Once",
  },
  deny: {
    emoji: "👎",
    label: "Deny",
  },
} satisfies Partial<Record<ExecApprovalReplyDecision, { emoji: string; label: string }>>;

const WHATSAPP_APPROVAL_REACTION_ORDER = [
  "allow-once",
  "deny",
] as const satisfies readonly ExecApprovalReplyDecision[];

const PERSISTENT_NAMESPACE = "whatsapp.approval-reactions";
const PERSISTENT_MAX_ENTRIES = 1000;
const DEFAULT_REACTION_TARGET_TTL_MS = 24 * 60 * 60 * 1000;

export type WhatsAppApprovalReactionBinding = {
  decision: ExecApprovalReplyDecision;
  emoji: string;
  label: string;
};

type WhatsAppApprovalReactionResolution = {
  approvalId: string;
  decision: ExecApprovalReplyDecision;
};

type WhatsAppApprovalReactionTarget = {
  approvalId: string;
  allowedDecisions: readonly ExecApprovalReplyDecision[];
};

type PersistedWhatsAppApprovalReactionTarget = {
  version: 1;
  target: WhatsAppApprovalReactionTarget;
};

type WhatsAppApprovalReactionStore = {
  register(
    key: string,
    value: PersistedWhatsAppApprovalReactionTarget,
    opts?: { ttlMs?: number },
  ): Promise<void>;
  lookup(key: string): Promise<PersistedWhatsAppApprovalReactionTarget | undefined>;
  delete(key: string): Promise<boolean>;
};

type WhatsAppApprovalReactionEvent = {
  remoteJid: string;
  messageId: string;
  actorJid: string;
  reactionKey: string;
};

const whatsappApprovalReactionTargets = new Map<string, WhatsAppApprovalReactionTarget>();
let persistentStore: WhatsAppApprovalReactionStore | undefined;
let persistentStoreDisabled = false;
let resolverRuntimePromise: Promise<typeof import("./approval-resolver.js")> | undefined;

function loadApprovalResolver(): Promise<typeof import("./approval-resolver.js")> {
  resolverRuntimePromise ??= import("./approval-resolver.js");
  return resolverRuntimePromise;
}

function buildReactionTargetKey(params: {
  accountId: string;
  remoteJid: string;
  messageId: string;
}) {
  const accountId = params.accountId.trim();
  const remoteJid = params.remoteJid.trim();
  const messageId = params.messageId.trim();
  if (!accountId || !remoteJid || !messageId) {
    return null;
  }
  return `${accountId}:${remoteJid}:${messageId}`;
}

function reportPersistentApprovalReactionError(error: unknown): void {
  try {
    getOptionalWhatsAppRuntime()
      ?.logging.getChildLogger({ plugin: "whatsapp", feature: "approval-reaction-state" })
      .warn("WhatsApp persistent approval reaction state failed", { error: String(error) });
  } catch {
    // Best effort only: persistent state must never break WhatsApp reactions.
  }
}

function disablePersistentApprovalReactionStore(error: unknown): void {
  persistentStoreDisabled = true;
  persistentStore = undefined;
  reportPersistentApprovalReactionError(error);
}

function getPersistentApprovalReactionStore(): WhatsAppApprovalReactionStore | undefined {
  if (persistentStoreDisabled) {
    return undefined;
  }
  if (persistentStore) {
    return persistentStore;
  }
  const runtime = getOptionalWhatsAppRuntime();
  if (!runtime) {
    return undefined;
  }
  try {
    persistentStore = runtime.state.openKeyedStore<PersistedWhatsAppApprovalReactionTarget>({
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

function readPersistedTarget(value: unknown): WhatsAppApprovalReactionTarget | null {
  const persisted = value as PersistedWhatsAppApprovalReactionTarget | undefined;
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
  target: WhatsAppApprovalReactionTarget;
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
): Promise<WhatsAppApprovalReactionTarget | null> {
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

export function listWhatsAppApprovalReactionBindings(
  allowedDecisions: readonly ExecApprovalReplyDecision[],
): WhatsAppApprovalReactionBinding[] {
  const allowed = new Set(allowedDecisions);
  return WHATSAPP_APPROVAL_REACTION_ORDER.filter((decision) => allowed.has(decision)).map(
    (decision) => ({
      decision,
      emoji: WHATSAPP_APPROVAL_REACTION_META[decision].emoji,
      label: WHATSAPP_APPROVAL_REACTION_META[decision].label,
    }),
  );
}

export function buildWhatsAppApprovalReactionHint(
  allowedDecisions: readonly ExecApprovalReplyDecision[],
): string | null {
  const bindings = listWhatsAppApprovalReactionBindings(allowedDecisions);
  if (bindings.length === 0) {
    return null;
  }
  return `React with:\n\n${bindings.map((binding) => `${binding.emoji} ${binding.label}`).join("\n")}`;
}

function insertWhatsAppApprovalReactionHintNearHeader(params: {
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

export function addWhatsAppApprovalReactionHintToText(params: {
  text: string;
  allowedDecisions: readonly ExecApprovalReplyDecision[];
}): string {
  if (/(^|\n)React with:\s*(\n|$)/i.test(params.text)) {
    return params.text;
  }
  const hint = buildWhatsAppApprovalReactionHint(params.allowedDecisions);
  return hint
    ? insertWhatsAppApprovalReactionHintNearHeader({ text: params.text, hint })
    : params.text;
}

export function appendWhatsAppApprovalReactionHintForOutboundMessage(text: string): string {
  if (/(^|\n)React with:\s*(\n|$)/i.test(text)) {
    return text;
  }
  const binding = extractWhatsAppApprovalPromptBinding(text);
  if (!binding) {
    return text;
  }
  return addWhatsAppApprovalReactionHintToText({
    text,
    allowedDecisions: binding.allowedDecisions,
  });
}

function resolveWhatsAppApprovalReactionDecision(
  reactionKey: string,
  allowedDecisions: readonly ExecApprovalReplyDecision[],
): ExecApprovalReplyDecision | null {
  const normalizedReaction = reactionKey.trim();
  if (!normalizedReaction) {
    return null;
  }
  const allowed = new Set(allowedDecisions);
  for (const decision of WHATSAPP_APPROVAL_REACTION_ORDER) {
    if (!allowed.has(decision)) {
      continue;
    }
    if (WHATSAPP_APPROVAL_REACTION_META[decision].emoji === normalizedReaction) {
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

export function extractWhatsAppApprovalPromptBinding(text: string): {
  approvalId: string;
  allowedDecisions: ExecApprovalReplyDecision[];
} | null {
  const allowedDecisions: ExecApprovalReplyDecision[] = [];
  let approvalId = "";
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/\/approve(?:@[^\s]+)?\s+([A-Za-z0-9][A-Za-z0-9._:-]*)\s+(.+)$/i);
    if (!match) {
      continue;
    }
    if (approvalId && match[1] !== approvalId) {
      continue;
    }
    approvalId ||= match[1];
    const decisions = match[2].split(/[\s|,]+/);
    for (const decisionText of decisions) {
      const decision = normalizeApprovalDecision(decisionText);
      if (decision && !allowedDecisions.includes(decision)) {
        allowedDecisions.push(decision);
      }
    }
  }
  return approvalId && allowedDecisions.length > 0 ? { approvalId, allowedDecisions } : null;
}

export function registerWhatsAppApprovalReactionTarget(params: {
  accountId: string;
  remoteJid: string;
  messageId: string;
  approvalId: string;
  allowedDecisions: readonly ExecApprovalReplyDecision[];
  ttlMs?: number;
}): WhatsAppApprovalReactionTarget | null {
  const key = buildReactionTargetKey(params);
  const approvalId = params.approvalId.trim();
  const allowedDecisions = listWhatsAppApprovalReactionBindings(params.allowedDecisions).map(
    (binding) => binding.decision,
  );
  if (!key || !approvalId || allowedDecisions.length === 0) {
    return null;
  }
  const target = { approvalId, allowedDecisions };
  whatsappApprovalReactionTargets.set(key, target);
  rememberPersistentApprovalReactionTarget({ key, target, ttlMs: params.ttlMs });
  return target;
}

export function registerWhatsAppApprovalReactionTargetForOutboundMessage(params: {
  accountId: string;
  remoteJid: string;
  messageId: string;
  text: string;
  ttlMs?: number;
}): boolean {
  const binding = extractWhatsAppApprovalPromptBinding(params.text);
  if (!binding) {
    return false;
  }
  return Boolean(
    registerWhatsAppApprovalReactionTarget({
      accountId: params.accountId,
      remoteJid: params.remoteJid,
      messageId: params.messageId,
      approvalId: binding.approvalId,
      allowedDecisions: binding.allowedDecisions,
      ttlMs: params.ttlMs,
    }),
  );
}

export function unregisterWhatsAppApprovalReactionTarget(params: {
  accountId: string;
  remoteJid: string;
  messageId: string;
}): void {
  const key = buildReactionTargetKey(params);
  if (!key) {
    return;
  }
  whatsappApprovalReactionTargets.delete(key);
  forgetPersistentApprovalReactionTarget(key);
}

function resolveTarget(params: {
  target: WhatsAppApprovalReactionTarget | null | undefined;
  reactionKey: string;
}): WhatsAppApprovalReactionResolution | null {
  const target = params.target;
  if (!target) {
    return null;
  }
  const decision = resolveWhatsAppApprovalReactionDecision(
    params.reactionKey,
    target.allowedDecisions,
  );
  return decision ? { approvalId: target.approvalId, decision } : null;
}

export async function resolveWhatsAppApprovalReactionTargetWithPersistence(params: {
  accountId: string;
  remoteJid: string;
  messageId: string;
  reactionKey: string;
}): Promise<WhatsAppApprovalReactionResolution | null> {
  const key = buildReactionTargetKey(params);
  if (!key) {
    return null;
  }
  const inMemory = resolveTarget({
    target: whatsappApprovalReactionTargets.get(key),
    reactionKey: params.reactionKey,
  });
  if (inMemory) {
    return inMemory;
  }
  return resolveTarget({
    target: await lookupPersistentApprovalReactionTarget(key),
    reactionKey: params.reactionKey,
  });
}

function readWhatsAppApprovalReactionEvent(params: {
  msg: WAMessage;
  selfJid?: string | null;
  selfLid?: string | null;
}): WhatsAppApprovalReactionEvent | null {
  const msg = params.msg;
  const reaction = msg.message?.reactionMessage;
  const reactionKey = reaction?.text?.trim() ?? "";
  const messageId = reaction?.key?.id?.trim() ?? "";
  const remoteJid = (reaction?.key?.remoteJid ?? msg.key?.remoteJid ?? "").trim();
  const actorJid =
    msg.key?.participant?.trim() ||
    (msg.key?.fromMe
      ? (params.selfLid?.trim() ?? params.selfJid?.trim() ?? "")
      : (msg.key?.remoteJid?.trim() ?? ""));
  if (!reactionKey || !messageId || !remoteJid || !actorJid) {
    return null;
  }
  return {
    remoteJid,
    messageId,
    actorJid,
    reactionKey,
  };
}

export async function maybeResolveWhatsAppApprovalReaction(params: {
  cfg: OpenClawConfig;
  accountId: string;
  msg: WAMessage;
  gatewayUrl?: string;
  selfJid?: string | null;
  selfLid?: string | null;
  resolveInboundJid: (jid: string | null | undefined) => Promise<string | null>;
  logVerboseMessage?: (message: string) => void;
}): Promise<boolean> {
  const event = readWhatsAppApprovalReactionEvent({
    msg: params.msg,
    selfJid: params.selfJid,
    selfLid: params.selfLid,
  });
  if (!event) {
    return false;
  }
  const target = await resolveWhatsAppApprovalReactionTargetWithPersistence({
    accountId: params.accountId,
    remoteJid: event.remoteJid,
    messageId: event.messageId,
    reactionKey: event.reactionKey,
  });
  if (!target) {
    return false;
  }

  const actorId = await params.resolveInboundJid(event.actorJid);
  if (!actorId) {
    params.logVerboseMessage?.(
      `whatsapp: approval reaction ignored for ${target.approvalId}; missing actor identity`,
    );
    return true;
  }

  const approvalKind = target.approvalId.startsWith("plugin:") ? "plugin" : "exec";
  const approvers = getWhatsAppApprovalApprovers({ cfg: params.cfg, accountId: params.accountId });
  if (approvers.length === 0) {
    params.logVerboseMessage?.(
      `whatsapp: approval reaction denied id=${target.approvalId}; reactions require explicit approvers`,
    );
    return true;
  }
  const auth = whatsappApprovalAuth.authorizeActorAction({
    cfg: params.cfg,
    accountId: params.accountId,
    senderId: actorId,
    action: "approve",
    approvalKind,
  });
  if (!auth.authorized) {
    params.logVerboseMessage?.(
      `whatsapp: approval reaction denied id=${target.approvalId} sender=${actorId}`,
    );
    return true;
  }

  const { isApprovalNotFoundError, resolveWhatsAppApproval } = await loadApprovalResolver();
  try {
    await resolveWhatsAppApproval({
      cfg: params.cfg,
      approvalId: target.approvalId,
      decision: target.decision,
      senderId: actorId,
      gatewayUrl: params.gatewayUrl,
    });
    params.logVerboseMessage?.(
      `whatsapp: approval reaction resolved id=${target.approvalId} sender=${actorId} decision=${target.decision}`,
    );
    return true;
  } catch (error) {
    if (isApprovalNotFoundError(error)) {
      unregisterWhatsAppApprovalReactionTarget({
        accountId: params.accountId,
        remoteJid: event.remoteJid,
        messageId: event.messageId,
      });
      params.logVerboseMessage?.(
        `whatsapp: approval reaction ignored for expired approval id=${target.approvalId} sender=${actorId}`,
      );
      return true;
    }
    params.logVerboseMessage?.(
      `whatsapp: approval reaction failed id=${target.approvalId} sender=${actorId}: ${String(error)}`,
    );
    return true;
  }
}

export function clearWhatsAppApprovalReactionTargetsForTest(): void {
  whatsappApprovalReactionTargets.clear();
  persistentStore = undefined;
  persistentStoreDisabled = false;
  resolverRuntimePromise = undefined;
}
