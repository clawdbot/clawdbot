import type { WAMessage } from "baileys";
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
import { getWhatsAppApprovalApprovers, whatsappApprovalAuth } from "./approval-auth.js";
import { getOptionalWhatsAppRuntime } from "./runtime.js";

const PERSISTENT_NAMESPACE = "whatsapp.approval-reactions";
const PERSISTENT_MAX_ENTRIES = 1000;
const DEFAULT_REACTION_TARGET_TTL_MS = 24 * 60 * 60 * 1000;

export type WhatsAppApprovalReactionBinding = ApprovalReactionDecisionBinding;

type WhatsAppApprovalReactionResolution = {
  approvalId: string;
  decision: ExecApprovalReplyDecision;
};

type WhatsAppApprovalReactionTarget = ApprovalReactionTargetRecord;

type WhatsAppApprovalReactionEvent = {
  remoteJid: string;
  messageId: string;
  actorJid: string;
  reactionKey: string;
};

let resolverRuntimePromise: Promise<typeof import("./approval-resolver.js")> | undefined;

const whatsappApprovalReactionTargets =
  createApprovalReactionTargetStore<WhatsAppApprovalReactionTarget>({
    namespace: PERSISTENT_NAMESPACE,
    maxEntries: PERSISTENT_MAX_ENTRIES,
    defaultTtlMs: DEFAULT_REACTION_TARGET_TTL_MS,
    openStore: (storeParams) => getOptionalWhatsAppRuntime()?.state.openKeyedStore(storeParams),
    logPersistentError: reportPersistentApprovalReactionError,
    readPersistedTarget,
  });

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

function readPersistedTarget(target: unknown): WhatsAppApprovalReactionTarget | null {
  const value = target as Partial<WhatsAppApprovalReactionTarget> | null | undefined;
  if (!value || typeof value.approvalId !== "string" || !Array.isArray(value.allowedDecisions)) {
    return null;
  }
  return {
    approvalId: value.approvalId,
    ...(value.approvalKind === "exec" || value.approvalKind === "plugin"
      ? { approvalKind: value.approvalKind }
      : {}),
    allowedDecisions: value.allowedDecisions,
  };
}

export function listWhatsAppApprovalReactionBindings(
  allowedDecisions: readonly ExecApprovalReplyDecision[],
): WhatsAppApprovalReactionBinding[] {
  return listApprovalReactionBindings({ allowedDecisions });
}

export function buildWhatsAppApprovalReactionHint(
  allowedDecisions: readonly ExecApprovalReplyDecision[],
): string | null {
  return buildApprovalReactionHint({ allowedDecisions });
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

export function extractWhatsAppApprovalPromptBinding(text: string): {
  approvalId: string;
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
  const allowedDecisions: ExecApprovalReplyDecision[] = [];
  for (const line of lines) {
    const match = line.match(APPROVE_COMMAND_LINE_RE);
    if (!match || match[1] !== approvalId) {
      continue;
    }
    for (const decisionText of match[2].split(/[\s|,]+/)) {
      const decision = normalizeApprovalDecision(decisionText);
      if (decision && !allowedDecisions.includes(decision)) {
        allowedDecisions.push(decision);
      }
    }
  }
  return allowedDecisions.length > 0 ? { approvalId, allowedDecisions } : null;
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
  const target: WhatsAppApprovalReactionTarget = {
    approvalId,
    approvalKind: approvalId.startsWith("plugin:") ? "plugin" : "exec",
    allowedDecisions,
  };
  whatsappApprovalReactionTargets.register(key, target, { ttlMs: params.ttlMs });
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
}

function resolveTarget(params: {
  target: WhatsAppApprovalReactionTarget | null | undefined;
  reactionKey: string;
}): WhatsAppApprovalReactionResolution | null {
  const resolved = resolveApprovalReactionTarget({
    target: params.target,
    reactionKey: params.reactionKey,
  });
  return resolved
    ? {
        approvalId: resolved.approvalId,
        decision: resolved.decision,
      }
    : null;
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
  return resolveTarget({
    target: await whatsappApprovalReactionTargets.lookup(key),
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
  whatsappApprovalReactionTargets.clearForTest();
  resolverRuntimePromise = undefined;
}
