// Whatsapp plugin module implements approval reactions behavior.
import type { WAMessage } from "baileys";
import {
  createApprovalReactionTargetStore,
  listApprovalReactionBindings,
  resolveTypedApprovalReactionTarget,
  type ApprovalReactionDecisionBinding,
  type ApprovalReactionTargetRecord,
} from "openclaw/plugin-sdk/approval-reaction-runtime";
import type { ExecApprovalReplyDecision } from "openclaw/plugin-sdk/approval-reply-runtime";
import type { OutboundDeliveryResult } from "openclaw/plugin-sdk/channel-send-result";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { MessagePresentation } from "openclaw/plugin-sdk/interactive-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { resolveWhatsAppAccount } from "./accounts.js";
import { getWhatsAppApprovalApprovers, whatsappApprovalAuth } from "./approval-auth.js";
import { getOptionalWhatsAppRuntime } from "./runtime.js";

const PERSISTENT_NAMESPACE = "whatsapp.approval-reactions";
const PERSISTENT_MAX_ENTRIES = 1000;
const DEFAULT_REACTION_TARGET_TTL_MS = 24 * 60 * 60 * 1000;
const DELIVERY_BINDING_CHANNEL_DATA_KEY = "whatsappApprovalReactionBindingV1";

type WhatsAppApprovalKind = "exec" | "plugin";

type WhatsAppApprovalDeliveryBinding = {
  version: 1;
  approvalId: string;
  approvalKind: WhatsAppApprovalKind;
  allowedDecisions: ExecApprovalReplyDecision[];
};

type WhatsAppApprovalReactionBinding = ApprovalReactionDecisionBinding;

type WhatsAppApprovalReactionResolution = {
  approvalId: string;
  approvalKind: WhatsAppApprovalKind;
  decision: ExecApprovalReplyDecision;
};

type WhatsAppApprovalReactionTarget = ApprovalReactionTargetRecord & {
  approvalKind: WhatsAppApprovalKind;
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

const resolverRuntimeLoader = createLazyRuntimeModule(() => import("./approval-resolver.js"));

const whatsappApprovalReactionTargets =
  createApprovalReactionTargetStore<WhatsAppApprovalReactionTarget>({
    namespace: PERSISTENT_NAMESPACE,
    maxEntries: PERSISTENT_MAX_ENTRIES,
    defaultTtlMs: DEFAULT_REACTION_TARGET_TTL_MS,
    openStore: (storeParams) => getOptionalWhatsAppRuntime()?.state.openKeyedStore(storeParams),
    logPersistentError: reportPersistentApprovalReactionError,
    readPersistedTarget,
  });

const loadApprovalResolver = resolverRuntimeLoader;

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

function reportPersistentApprovalReactionError(error: unknown): void {
  try {
    getOptionalWhatsAppRuntime()
      ?.logging.getChildLogger({ plugin: "whatsapp", feature: "approval-reaction-state" })
      .warn("WhatsApp persistent approval reaction state failed", { error: String(error) });
  } catch {
    // Best effort only: persistent state must never break WhatsApp reactions.
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
    !Array.isArray(value.allowedDecisions) ||
    (value.approvalKind !== "exec" && value.approvalKind !== "plugin")
  ) {
    return null;
  }
  return {
    approvalId: value.approvalId,
    approvalKind: value.approvalKind,
    allowedDecisions: value.allowedDecisions,
  };
}

function listWhatsAppApprovalReactionBindings(
  allowedDecisions: readonly ExecApprovalReplyDecision[],
): WhatsAppApprovalReactionBinding[] {
  return listApprovalReactionBindings({ allowedDecisions });
}

const APPROVAL_ID_LINE_RE = /^\s*ID:\s*(\S(?:.*\S)?)\s*$/i;
const APPROVAL_KIND_LINE_RE = /^\s*(?:\S+\s+)?(Exec|Plugin) approval required\s*$/i;

function isApprovalDecision(value: unknown): value is ExecApprovalReplyDecision {
  return value === "allow-once" || value === "allow-always" || value === "deny";
}

function readStrictDecisionList(value: unknown): ExecApprovalReplyDecision[] | null {
  if (!Array.isArray(value) || value.length === 0 || !value.every(isApprovalDecision)) {
    return null;
  }
  return new Set(value).size === value.length ? [...value] : null;
}

function readStrictApprovalMetadata(payload: ReplyPayload): WhatsAppApprovalDeliveryBinding | null {
  const value = payload.channelData?.execApproval;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const approvalId = record.approvalId;
  const approvalKind = record.approvalKind;
  const allowedDecisions = readStrictDecisionList(record.allowedDecisions);
  if (
    typeof approvalId !== "string" ||
    !approvalId ||
    approvalId !== approvalId.trim() ||
    (approvalKind !== "exec" && approvalKind !== "plugin") ||
    !allowedDecisions
  ) {
    return null;
  }
  return { version: 1, approvalId, approvalKind, allowedDecisions };
}

function listTypedApprovalActions(presentation: MessagePresentation) {
  return presentation.blocks.flatMap((block) => {
    if (block.type === "buttons") {
      return block.buttons.flatMap((button) =>
        button.action?.type === "approval" ? [button.action] : [],
      );
    }
    return [];
  });
}

function decisionSetsMatch(
  left: readonly ExecApprovalReplyDecision[],
  right: readonly ExecApprovalReplyDecision[],
): boolean {
  return left.length === right.length && left.every((decision) => right.includes(decision));
}

function readTypedApprovalDeliveryBinding(params: {
  payload: ReplyPayload;
  presentation: MessagePresentation;
}): WhatsAppApprovalDeliveryBinding | null {
  const metadata = readStrictApprovalMetadata(params.payload);
  if (!metadata) {
    return null;
  }
  const actions = listTypedApprovalActions(params.presentation);
  if (
    actions.length === 0 ||
    actions.some(
      (action) =>
        action.approvalId !== metadata.approvalId || action.approvalKind !== metadata.approvalKind,
    )
  ) {
    return null;
  }
  const actionDecisions = actions.map((action) => action.decision);
  if (
    new Set(actionDecisions).size !== actionDecisions.length ||
    !decisionSetsMatch(metadata.allowedDecisions, actionDecisions)
  ) {
    return null;
  }
  return metadata;
}

function visibleApprovalBindingMatches(
  text: string | null | undefined,
  binding: WhatsAppApprovalDeliveryBinding,
): boolean {
  // Text is only a correlation check. The typed metadata/action binding remains
  // authoritative so transport copy can never choose an approval owner or id.
  const lines = (text ?? "").split(/\r?\n/);
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
  const knownBindings = listWhatsAppApprovalReactionBindings([
    "allow-once",
    "allow-always",
    "deny",
  ]);
  const visibleDecisions = decisionLines.map(
    (line) => knownBindings.find((entry) => `${entry.emoji} ${entry.label}` === line)?.decision,
  );
  if (!visibleDecisions.every(isApprovalDecision)) {
    return false;
  }
  return (
    new Set(visibleDecisions).size === visibleDecisions.length &&
    decisionSetsMatch(binding.allowedDecisions, visibleDecisions)
  );
}

function readDeliveredApprovalBinding(
  payload: ReplyPayload,
): WhatsAppApprovalDeliveryBinding | null {
  const metadata = readStrictApprovalMetadata(payload);
  const value = payload.channelData?.[DELIVERY_BINDING_CHANNEL_DATA_KEY];
  if (!metadata || !value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const allowedDecisions = readStrictDecisionList(record.allowedDecisions);
  if (
    record.version !== 1 ||
    record.approvalId !== metadata.approvalId ||
    record.approvalKind !== metadata.approvalKind ||
    !allowedDecisions ||
    !decisionSetsMatch(metadata.allowedDecisions, allowedDecisions)
  ) {
    return null;
  }
  return metadata;
}

/** Preserve a validated typed approval binding until the platform message id is known. */
export function prepareWhatsAppApprovalPayloadForDelivery(params: {
  payload: ReplyPayload;
  presentation: MessagePresentation;
}): ReplyPayload | null {
  const binding = readTypedApprovalDeliveryBinding(params);
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
      [DELIVERY_BINDING_CHANNEL_DATA_KEY]: binding,
    },
  };
}

export function registerWhatsAppApprovalReactionTarget(params: {
  accountId: string;
  remoteJid: string;
  messageId: string;
  approvalId: string;
  approvalKind: "exec" | "plugin";
  allowedDecisions: readonly ExecApprovalReplyDecision[];
  ttlMs?: number;
}): WhatsAppApprovalReactionTarget | null {
  const key = buildReactionTargetKey(params);
  const approvalId = params.approvalId.trim();
  const allowedDecisions = listWhatsAppApprovalReactionBindings(params.allowedDecisions).map(
    (binding) => binding.decision,
  );
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
  const binding = readDeliveredApprovalBinding(params.payload);
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

  const { isApprovalNotFoundError, resolveWhatsAppApproval } = await loadApprovalResolver();
  try {
    const result = await resolveWhatsAppApproval({
      cfg: params.cfg,
      approvalId: target.approvalId,
      approvalKind: target.approvalKind,
      decision: target.decision,
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
  resolverRuntimeLoader.clear();
}
