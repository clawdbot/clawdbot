// Whatsapp plugin module implements approval reactions behavior.
import type { WAMessage } from "baileys";
import type { ChannelApprovalKind } from "openclaw/plugin-sdk/approval-handler-runtime";
import {
  approvalReactionDecisionSetsMatch,
  buildApprovalReactionDeliveredBindingMarker,
  createApprovalReactionTargetStore,
  listApprovalReactionBindings,
  readApprovalReactionDecisionList,
  readApprovalReactionDeliveredBinding,
  readApprovalReactionPresentationBinding,
  resolveTypedApprovalReactionTarget,
  type ApprovalReactionDeliveryBinding,
  type ApprovalReactionTargetRecord,
} from "openclaw/plugin-sdk/approval-reaction-runtime";
import type { ExecApprovalReplyDecision } from "openclaw/plugin-sdk/approval-reply-runtime";
import type { OutboundDeliveryResult } from "openclaw/plugin-sdk/channel-send-result";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { isApprovalNotFoundError } from "openclaw/plugin-sdk/error-runtime";
import type { MessagePresentation } from "openclaw/plugin-sdk/interactive-runtime";
import { createLazyRuntimeSurface } from "openclaw/plugin-sdk/lazy-runtime";
import { createPluginStateErrorReporter } from "openclaw/plugin-sdk/plugin-state-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { resolveWhatsAppAccount } from "./accounts.js";
import { getWhatsAppApprovalApprovers, whatsappApprovalAuth } from "./approval-auth.js";
import { getOptionalWhatsAppRuntime } from "./runtime.js";

const PERSISTENT_NAMESPACE = "whatsapp.approval-reactions";
const PERSISTENT_MAX_ENTRIES = 1000;
const DEFAULT_REACTION_TARGET_TTL_MS = 24 * 60 * 60 * 1000;
const DELIVERY_BINDING_CHANNEL_DATA_KEY = "whatsappApprovalReactionBindingV1";

type WhatsAppApprovalDeliveryBinding = ApprovalReactionDeliveryBinding;

type WhatsAppApprovalReactionResolution = {
  approvalId: string;
  approvalKind: ChannelApprovalKind;
  decision: ExecApprovalReplyDecision;
};

type WhatsAppApprovalReactionTarget = ApprovalReactionTargetRecord & {
  approvalKind: ChannelApprovalKind;
};

type WhatsAppApprovalReactionEvent = {
  remoteJids: string[];
  messageId: string;
  actorJid: string;
  reactionKey: string;
};

type ResolvedWhatsAppApprovalReactionTarget = WhatsAppApprovalReactionResolution & {
  remoteJid: string;
};

const loadResolveApprovalOverGateway = createLazyRuntimeSurface(
  () => import("openclaw/plugin-sdk/approval-gateway-runtime"),
  (runtime) => runtime.resolveApprovalOverGateway,
);

const reportPersistentApprovalReactionError = createPluginStateErrorReporter(
  getOptionalWhatsAppRuntime,
  "whatsapp",
  "approval-reaction-state",
  "WhatsApp persistent approval reaction state failed",
);

const whatsappApprovalReactionTargets =
  createApprovalReactionTargetStore<WhatsAppApprovalReactionTarget>({
    namespace: PERSISTENT_NAMESPACE,
    maxEntries: PERSISTENT_MAX_ENTRIES,
    defaultTtlMs: DEFAULT_REACTION_TARGET_TTL_MS,
    openStore: (storeParams) => getOptionalWhatsAppRuntime()?.state.openKeyedStore(storeParams),
    logPersistentError: reportPersistentApprovalReactionError,
    readPersistedTarget,
  });

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

function addCandidateRemoteJid(target: string[], value: string | null | undefined): void {
  const remoteJid = value?.trim();
  if (remoteJid && !target.includes(remoteJid)) {
    target.push(remoteJid);
  }
}

function reportApprovalBindingCorrelationMismatch(binding: {
  approvalId: string;
  approvalKind: string;
}): void {
  // Fail closed but never silently: a pending command whose text collides with
  // the marker lines would otherwise disable reactions with no operator signal.
  try {
    getOptionalWhatsAppRuntime()
      ?.logging.getChildLogger({ plugin: "whatsapp", feature: "approval-reaction-state" })
      .warn("WhatsApp approval prompt text failed binding correlation; reactions disabled", {
        approvalId: binding.approvalId,
        approvalKind: binding.approvalKind,
      });
  } catch {
    // Best effort only.
  }
}

function readPersistedTarget(target: unknown): WhatsAppApprovalReactionTarget | null {
  const value = target as Partial<WhatsAppApprovalReactionTarget> | null | undefined;
  if (
    !value ||
    typeof value.approvalId !== "string" ||
    (value.approvalKind !== "exec" && value.approvalKind !== "plugin")
  ) {
    return null;
  }
  const allowedDecisions = readApprovalReactionDecisionList(value.allowedDecisions);
  if (!allowedDecisions) {
    return null;
  }
  return {
    approvalId: value.approvalId,
    approvalKind: value.approvalKind,
    allowedDecisions,
  };
}

const APPROVAL_ID_LINE_RE = /^\s*ID:\s*(\S(?:.*\S)?)\s*$/i;
const APPROVAL_KIND_LINE_RE = /^\s*(?:\S+\s+)?(Exec|Plugin) approval required\s*$/i;

function visibleApprovalBindingMatches(
  text: string | null | undefined,
  binding: WhatsAppApprovalDeliveryBinding,
): boolean {
  // Text is only a correlation check. The typed metadata/action binding remains
  // authoritative so transport copy can never choose an approval owner or id.
  // Strip bold markers (**Exec approval required**, **ID:** …) the prompt
  // builder emits so the canonical-format match still correlates.
  const lines = (text ?? "").split(/\r?\n/).map((line) => line.replace(/\*\*/g, ""));
  const kindMatches = lines
    .map((line) => line.match(APPROVAL_KIND_LINE_RE))
    .filter((match): match is RegExpMatchArray => Boolean(match));
  const idMatches = lines
    .map((line) => line.match(APPROVAL_ID_LINE_RE))
    .filter((match): match is RegExpMatchArray => Boolean(match));
  const visibleKind = kindMatches[0]?.[1]?.toLowerCase();
  if (
    kindMatches.length !== 1 ||
    idMatches.length !== 1 ||
    visibleKind !== binding.approvalKind ||
    idMatches[0]?.[1] !== binding.approvalId
  ) {
    return false;
  }

  const hintIndices = lines.flatMap((line, index) =>
    line.trim().toLowerCase() === "react with:" ? [index] : [],
  );
  if (hintIndices.length !== 1) {
    return false;
  }
  const hintIndex = hintIndices[0];
  if (hintIndex === undefined) {
    return false;
  }
  let cursor = hintIndex + 1;
  while (cursor < lines.length && !lines[cursor]?.trim()) {
    cursor += 1;
  }
  const decisionLines: string[] = [];
  while (cursor < lines.length) {
    const decisionLine = lines[cursor]?.trim();
    if (!decisionLine) {
      break;
    }
    decisionLines.push(decisionLine);
    cursor += 1;
  }
  const knownBindings = listApprovalReactionBindings({
    allowedDecisions: ["allow-once", "allow-always", "deny"],
  });
  const visibleDecisions = decisionLines.map(
    (line) => knownBindings.find((entry) => `${entry.emoji} ${entry.label}` === line)?.decision,
  );
  const decisions = readApprovalReactionDecisionList(visibleDecisions);
  if (!decisions) {
    return false;
  }
  return approvalReactionDecisionSetsMatch(binding.allowedDecisions, decisions);
}

/** Preserve a validated typed approval binding until the platform message id is known. */
export function prepareWhatsAppApprovalPayloadForDelivery(params: {
  payload: ReplyPayload;
  presentation: MessagePresentation;
}): ReplyPayload | null {
  const binding = readApprovalReactionPresentationBinding(params);
  if (!binding) {
    return null;
  }
  if (!visibleApprovalBindingMatches(params.payload.text, binding)) {
    reportApprovalBindingCorrelationMismatch(binding);
    return null;
  }
  return {
    ...params.payload,
    channelData: {
      ...params.payload.channelData,
      [DELIVERY_BINDING_CHANNEL_DATA_KEY]: buildApprovalReactionDeliveredBindingMarker(binding),
    },
  };
}

export function registerWhatsAppApprovalReactionTarget(params: {
  accountId: string;
  remoteJid: string;
  messageId: string;
  approvalId: string;
  approvalKind: ChannelApprovalKind;
  allowedDecisions: readonly ExecApprovalReplyDecision[];
  ttlMs?: number;
}): WhatsAppApprovalReactionTarget | null {
  const key = buildReactionTargetKey(params);
  const approvalId = params.approvalId.trim();
  const allowedDecisions = listApprovalReactionBindings({
    allowedDecisions: params.allowedDecisions,
  }).map((binding) => binding.decision);
  if (
    !key ||
    !approvalId ||
    (params.approvalKind !== "exec" && params.approvalKind !== "plugin") ||
    allowedDecisions.length === 0
  ) {
    return null;
  }
  const target: WhatsAppApprovalReactionTarget = {
    approvalId,
    approvalKind: params.approvalKind,
    allowedDecisions,
  };
  whatsappApprovalReactionTargets.register(key, target, { ttlMs: params.ttlMs });
  return target;
}

function listWhatsAppDeliveredMessageIdentities(
  results: readonly OutboundDeliveryResult[],
): Array<{ messageId: string; remoteJid: string }> {
  const identities: Array<{ messageId: string; remoteJid: string }> = [];
  const seen = new Set<string>();
  const add = (params: { channel?: string; messageId?: string; toJid?: string }) => {
    if (params.channel && params.channel !== "whatsapp") {
      return;
    }
    const messageId = params.messageId?.trim() ?? "";
    const remoteJid = params.toJid?.trim() ?? "";
    const key = `${remoteJid}:${messageId}`;
    if (!messageId || messageId === "unknown" || !remoteJid || seen.has(key)) {
      return;
    }
    seen.add(key);
    identities.push({ messageId, remoteJid });
  };

  for (const result of results) {
    if (result.channel !== "whatsapp") {
      continue;
    }
    add(result);
    for (const raw of result.receipt?.raw ?? []) {
      add(raw);
    }
    for (const part of result.receipt?.parts ?? []) {
      add({
        channel: part.raw?.channel,
        messageId: part.raw?.messageId ?? part.platformMessageId,
        toJid: part.raw?.toJid,
      });
    }
  }
  return identities;
}

/** Bind generic forwarded approvals to the exact WhatsApp messages accepted by Baileys. */
export function registerWhatsAppApprovalReactionTargetForDeliveredPayload(params: {
  cfg: OpenClawConfig;
  target: { channel: string; to: string; accountId?: string | null };
  payload: ReplyPayload;
  results: readonly OutboundDeliveryResult[];
  ttlMs?: number;
}): boolean {
  if (params.target.channel.trim().toLowerCase() !== "whatsapp") {
    return false;
  }
  const binding = readApprovalReactionDeliveredBinding({
    payload: params.payload,
    channelDataKey: DELIVERY_BINDING_CHANNEL_DATA_KEY,
  });
  if (!binding) {
    return false;
  }
  if (!visibleApprovalBindingMatches(params.payload.text, binding)) {
    reportApprovalBindingCorrelationMismatch(binding);
    return false;
  }
  const accountId = resolveWhatsAppAccount({
    cfg: params.cfg,
    accountId: params.target.accountId,
  }).accountId;
  let registered = false;
  for (const { messageId, remoteJid } of listWhatsAppDeliveredMessageIdentities(params.results)) {
    registered =
      Boolean(
        registerWhatsAppApprovalReactionTarget({
          accountId,
          remoteJid,
          messageId,
          approvalId: binding.approvalId,
          approvalKind: binding.approvalKind,
          allowedDecisions: binding.allowedDecisions,
          ttlMs: params.ttlMs,
        }),
      ) || registered;
  }
  return registered;
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
  const resolved = resolveTypedApprovalReactionTarget({
    target: params.target,
    reactionKey: params.reactionKey,
  });
  return resolved
    ? {
        approvalId: resolved.approvalId,
        approvalKind: resolved.approvalKind,
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

async function resolveWhatsAppApprovalReactionTargetFromCandidates(params: {
  accountId: string;
  observedRemoteJids: readonly string[];
  messageId: string;
  reactionKey: string;
  resolveReactionTargetJids?: (jid: string) => Promise<readonly string[]>;
  logVerboseMessage?: (message: string) => void;
}): Promise<ResolvedWhatsAppApprovalReactionTarget | null> {
  const candidateRemoteJids: string[] = [];
  for (const observedRemoteJid of params.observedRemoteJids) {
    addCandidateRemoteJid(candidateRemoteJids, observedRemoteJid);
    try {
      for (const candidate of (await params.resolveReactionTargetJids?.(observedRemoteJid)) ?? []) {
        addCandidateRemoteJid(candidateRemoteJids, candidate);
      }
    } catch (error) {
      params.logVerboseMessage?.(
        `whatsapp: approval reaction target JID mapping failed for ${observedRemoteJid}: ${String(error)}`,
      );
    }
  }

  for (const remoteJid of candidateRemoteJids) {
    const target = await resolveWhatsAppApprovalReactionTargetWithPersistence({
      accountId: params.accountId,
      remoteJid,
      messageId: params.messageId,
      reactionKey: params.reactionKey,
    });
    if (target) {
      return { ...target, remoteJid };
    }
  }
  return null;
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
  const remoteJids: string[] = [];
  addCandidateRemoteJid(remoteJids, reaction?.key?.remoteJid);
  addCandidateRemoteJid(remoteJids, msg.key?.remoteJid);
  const actorJid =
    msg.key?.participant?.trim() ||
    (msg.key?.fromMe
      ? (params.selfLid?.trim() ?? params.selfJid?.trim() ?? "")
      : (msg.key?.remoteJid?.trim() ?? ""));
  if (!reactionKey || !messageId || remoteJids.length === 0 || !actorJid) {
    return null;
  }
  return {
    remoteJids,
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
  resolveReactionTargetJids?: (jid: string) => Promise<readonly string[]>;
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
  const target = await resolveWhatsAppApprovalReactionTargetFromCandidates({
    accountId: params.accountId,
    observedRemoteJids: event.remoteJids,
    messageId: event.messageId,
    reactionKey: event.reactionKey,
    resolveReactionTargetJids: params.resolveReactionTargetJids,
    logVerboseMessage: params.logVerboseMessage,
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
    approvalKind: target.approvalKind,
  });
  if (!auth.authorized) {
    params.logVerboseMessage?.(
      `whatsapp: approval reaction denied id=${target.approvalId} sender=${actorId}`,
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
      channel: "whatsapp",
      accountId: params.accountId,
      senderId: actorId,
      gatewayUrl: params.gatewayUrl,
    });
    unregisterWhatsAppApprovalReactionTarget({
      accountId: params.accountId,
      remoteJid: target.remoteJid,
      messageId: event.messageId,
    });
    const canonicalDecision =
      "decision" in result.approval ? ` decision=${result.approval.decision}` : "";
    params.logVerboseMessage?.(
      result.applied
        ? `whatsapp: approval reaction applied id=${target.approvalId} sender=${actorId} status=${result.approval.status}${canonicalDecision}`
        : `whatsapp: approval reaction already resolved id=${target.approvalId} sender=${actorId} status=${result.approval.status}${canonicalDecision}`,
    );
    return true;
  } catch (error) {
    if (isApprovalNotFoundError(error)) {
      unregisterWhatsAppApprovalReactionTarget({
        accountId: params.accountId,
        remoteJid: target.remoteJid,
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
  loadResolveApprovalOverGateway.clear();
}
