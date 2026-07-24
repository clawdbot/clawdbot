import crypto from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { hasOutboundReplyContent } from "openclaw/plugin-sdk/reply-payload";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { runAgentHarnessBeforeMessageWriteHook } from "../../agents/harness/hook-helpers.js";
import { resolveStorePath } from "../../config/sessions/paths.js";
import { patchSessionEntry } from "../../config/sessions/session-accessor.js";
import { appendAssistantMessageToSessionTranscript } from "../../config/sessions/transcript.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  getReplyPayloadMetadata,
  isReplyPayloadOperationalNotice,
  type ReplyPayload,
} from "../reply-payload.js";

const deliveredOperationalReplyOnceKeys = new Set<string>();
const pendingOperationalReplyOnceKeys = new Set<string>();
const MAX_OPERATIONAL_REPLY_ONCE_KEYS = 1024;

type OperationalReplyPolicy = "always" | "once" | "redirect" | "silent";

type OperationalReplyPolicyResult =
  | { markDelivered?: (delivered: boolean) => Promise<void> | void; shouldDeliver: true }
  | { intentionalSilence: true; redirected?: boolean; shouldDeliver: false };

export async function markOperationalReplyPolicyDelivered(
  result: OperationalReplyPolicyResult,
  delivered: boolean,
): Promise<void> {
  if (result.shouldDeliver) {
    await result.markDelivered?.(delivered);
  }
}

function clearOperationalReplyPolicyStateForTest(): void {
  deliveredOperationalReplyOnceKeys.clear();
  pendingOperationalReplyOnceKeys.clear();
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.operationalReplyPolicyTestApi")
  ] = { clearOperationalReplyPolicyStateForTest };
}

export function resolveOperationalReplyPolicy(cfg: OpenClawConfig): {
  policy: OperationalReplyPolicy;
  redirectSessionKey?: string;
} {
  const operationalReplies = cfg.messages?.operationalReplies;
  return {
    policy: operationalReplies?.policy ?? "always",
    ...(normalizeOptionalString(operationalReplies?.redirectSessionKey)
      ? { redirectSessionKey: normalizeOptionalString(operationalReplies?.redirectSessionKey) }
      : {}),
  };
}

export function isOperationalReplyPayload(params: {
  payload: ReplyPayload;
  explicitCommandTurn: boolean;
}): boolean {
  const metadata = getReplyPayloadMetadata(params.payload);
  if (metadata?.beforeAgentRunBlocked === true) {
    return false;
  }
  if (params.explicitCommandTurn && metadata?.commandReply === true) {
    return false;
  }
  if (isReplyPayloadOperationalNotice(params.payload)) {
    return true;
  }
  return (
    metadata?.deliverDespiteSourceReplySuppression === true &&
    !metadata.sourceReplyTranscriptMirror &&
    !params.explicitCommandTurn
  );
}

function resolveOperationalReplyKind(payload: ReplyPayload): string {
  const metadata = getReplyPayloadMetadata(payload);
  if (payload.isError === true) {
    return "error";
  }
  if (payload.isFallbackNotice === true) {
    return "fallback";
  }
  if (payload.isCompactionNotice === true) {
    return "compaction";
  }
  if (payload.isStatusNotice === true) {
    return "status";
  }
  if (metadata?.nonTerminalToolErrorWarning === true) {
    return "tool-warning";
  }
  if (metadata?.deliverDespiteSourceReplySuppression === true) {
    return "runtime-notice";
  }
  return "notice";
}

function createOperationalReplyOnceKey(params: {
  payload: ReplyPayload;
  sessionKey?: string;
}): string {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        sessionKey: params.sessionKey ?? "unknown",
        kind: resolveOperationalReplyKind(params.payload),
        text: params.payload.text ?? "",
        mediaUrl: params.payload.mediaUrl ?? "",
        mediaUrls: params.payload.mediaUrls ?? [],
      }),
    )
    .digest("hex");
}

function createOperationalReplyRedirectKey(params: {
  payload: ReplyPayload;
  sourceEventKey: string;
  sourceSessionKey?: string;
}): string {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        sourceEventKey: params.sourceEventKey,
        sessionKey: params.sourceSessionKey ?? "unknown",
        kind: resolveOperationalReplyKind(params.payload),
        text: params.payload.text ?? "",
        mediaUrl: params.payload.mediaUrl ?? "",
        mediaUrls: params.payload.mediaUrls ?? [],
      }),
    )
    .digest("hex");
}

function reserveOperationalReplyOnceKeyInMemory(key: string): boolean {
  if (hasOperationalReplyOnceKey(key)) {
    return false;
  }
  pendingOperationalReplyOnceKeys.add(key);
  return true;
}

function releaseOperationalReplyOnceKeyInMemory(key: string): void {
  pendingOperationalReplyOnceKeys.delete(key);
}

function markOperationalReplyOnceKeyDeliveredInMemory(key: string): void {
  pendingOperationalReplyOnceKeys.delete(key);
  deliveredOperationalReplyOnceKeys.delete(key);
  deliveredOperationalReplyOnceKeys.add(key);
  while (deliveredOperationalReplyOnceKeys.size > MAX_OPERATIONAL_REPLY_ONCE_KEYS) {
    const oldestKey = deliveredOperationalReplyOnceKeys.values().next().value;
    if (!oldestKey) {
      return;
    }
    deliveredOperationalReplyOnceKeys.delete(oldestKey);
  }
}

function hasOperationalReplyOnceKey(key: string): boolean {
  return deliveredOperationalReplyOnceKeys.has(key) || pendingOperationalReplyOnceKeys.has(key);
}

function normalizeOperationalReplyOnceKeys(
  value: SessionEntry["operationalReplyOnceKeys"],
): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((key): key is string => typeof key === "string" && key.trim().length > 0);
}

function appendOperationalReplyOnceKey(keys: readonly string[], key: string): string[] {
  return [...keys, key];
}

function removeOperationalReplyOnceKey(keys: readonly string[], key: string): string[] {
  return keys.filter((existingKey) => existingKey !== key);
}

function boundOperationalReplyOnceKeys(keys: readonly string[]): string[] {
  return keys.slice(-MAX_OPERATIONAL_REPLY_ONCE_KEYS);
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function resolveOperationalReplySourceScope(params: {
  cfg: OpenClawConfig;
  sourceSessionKey?: string;
  sourceStorePath?: string;
}): { sessionKey: string; storePath: string } | null {
  const sessionKey = normalizeOptionalString(params.sourceSessionKey);
  if (!sessionKey) {
    return null;
  }
  const explicitStorePath = normalizeOptionalString(params.sourceStorePath);
  if (explicitStorePath) {
    return { sessionKey, storePath: explicitStorePath };
  }
  try {
    const agentId = resolveSessionAgentId({
      sessionKey,
      config: params.cfg,
    });
    return {
      sessionKey,
      storePath: resolveStorePath(params.cfg.session?.store, { agentId }),
    };
  } catch (error) {
    logVerbose(`operational-reply-policy: once scope unavailable: ${formatErrorMessage(error)}`);
    return null;
  }
}

type OperationalReplyOnceReservation = {
  durableReserved: boolean;
  key: string;
  scope?: { sessionKey: string; storePath: string };
};

async function reserveOperationalReplyOnceKey(params: {
  cfg: OpenClawConfig;
  key: string;
  sourceSessionKey?: string;
  sourceStorePath?: string;
}): Promise<OperationalReplyOnceReservation | null> {
  if (hasOperationalReplyOnceKey(params.key)) {
    return null;
  }
  const scope = resolveOperationalReplySourceScope(params);
  if (!scope) {
    return reserveOperationalReplyOnceKeyInMemory(params.key)
      ? { durableReserved: false, key: params.key }
      : null;
  }
  try {
    let reserved = false;
    let alreadySeen = false;
    await patchSessionEntry(
      scope,
      (entry) => {
        const deliveredKeys = normalizeOperationalReplyOnceKeys(entry.operationalReplyOnceKeys);
        if (deliveredKeys.includes(params.key)) {
          alreadySeen = true;
          return null;
        }
        const pendingKeys = normalizeOperationalReplyOnceKeys(
          entry.operationalReplyPendingOnceKeys,
        );
        // Durable pending keys can be stale after restart; only live in-memory
        // pending state blocks concurrent duplicates from this process.
        if (pendingKeys.includes(params.key) && pendingOperationalReplyOnceKeys.has(params.key)) {
          alreadySeen = true;
          return null;
        }
        reserved = true;
        return {
          operationalReplyPendingOnceKeys: appendOperationalReplyOnceKey(
            removeOperationalReplyOnceKey(pendingKeys, params.key),
            params.key,
          ),
        };
      },
      { preserveActivity: true },
    );
    if (alreadySeen) {
      return null;
    }
    if (reserved) {
      reserveOperationalReplyOnceKeyInMemory(params.key);
      return { durableReserved: true, key: params.key, scope };
    }
    return reserveOperationalReplyOnceKeyInMemory(params.key)
      ? { durableReserved: false, key: params.key }
      : null;
  } catch (error) {
    logVerbose(`operational-reply-policy: once persistence skipped: ${formatErrorMessage(error)}`);
    return reserveOperationalReplyOnceKeyInMemory(params.key)
      ? { durableReserved: false, key: params.key }
      : null;
  }
}

async function releaseOperationalReplyOnceReservation(
  reservation: OperationalReplyOnceReservation,
): Promise<void> {
  releaseOperationalReplyOnceKeyInMemory(reservation.key);
  if (!reservation.durableReserved || !reservation.scope) {
    return;
  }
  try {
    await patchSessionEntry(
      reservation.scope,
      (entry) => {
        const keys = normalizeOperationalReplyOnceKeys(entry.operationalReplyPendingOnceKeys);
        if (!keys.includes(reservation.key)) {
          return null;
        }
        const nextKeys = removeOperationalReplyOnceKey(keys, reservation.key);
        return {
          operationalReplyPendingOnceKeys: nextKeys.length > 0 ? nextKeys : undefined,
        };
      },
      { preserveActivity: true },
    );
  } catch (error) {
    logVerbose(
      `operational-reply-policy: once reservation release skipped: ${formatErrorMessage(error)}`,
    );
  }
}

async function finalizeOperationalReplyOnceReservation(
  reservation: OperationalReplyOnceReservation,
): Promise<void> {
  markOperationalReplyOnceKeyDeliveredInMemory(reservation.key);
  if (!reservation.durableReserved || !reservation.scope) {
    return;
  }
  try {
    await patchSessionEntry(
      reservation.scope,
      (entry) => {
        const deliveredKeys = normalizeOperationalReplyOnceKeys(entry.operationalReplyOnceKeys);
        const pendingKeys = normalizeOperationalReplyOnceKeys(
          entry.operationalReplyPendingOnceKeys,
        );
        const nextDeliveredKeys = boundOperationalReplyOnceKeys(
          appendOperationalReplyOnceKey(
            removeOperationalReplyOnceKey(deliveredKeys, reservation.key),
            reservation.key,
          ),
        );
        const nextPendingKeys = removeOperationalReplyOnceKey(pendingKeys, reservation.key);
        if (
          arraysEqual(nextDeliveredKeys, deliveredKeys) &&
          arraysEqual(nextPendingKeys, pendingKeys)
        ) {
          return null;
        }
        return {
          operationalReplyOnceKeys: nextDeliveredKeys.length > 0 ? nextDeliveredKeys : undefined,
          operationalReplyPendingOnceKeys: nextPendingKeys.length > 0 ? nextPendingKeys : undefined,
        };
      },
      { preserveActivity: true },
    );
  } catch (error) {
    logVerbose(
      `operational-reply-policy: once reservation finalization skipped: ${formatErrorMessage(error)}`,
    );
  }
}

function formatOperationalReplyPayloadForLog(reply: ReplyPayload): string {
  const parts = [
    reply.text ? `text=${JSON.stringify(reply.text.slice(0, 160))}` : undefined,
    reply.mediaUrl ? `mediaUrl=${JSON.stringify(reply.mediaUrl)}` : undefined,
    reply.mediaUrls?.length ? `mediaUrls=${reply.mediaUrls.length}` : undefined,
    reply.isError ? "isError=true" : undefined,
    reply.isFallbackNotice ? "isFallbackNotice=true" : undefined,
    reply.isCompactionNotice ? "isCompactionNotice=true" : undefined,
    reply.isStatusNotice ? "isStatusNotice=true" : undefined,
  ];
  return parts.filter((part): part is string => Boolean(part)).join(" ");
}

function formatOperationalReplyRedirectText(params: {
  payload: ReplyPayload;
  sourceChannel?: string;
  sourceEventKey?: string;
  sourceSessionKey?: string;
}): string {
  const kind = resolveOperationalReplyKind(params.payload);
  const sourceSessionKey = normalizeOptionalString(params.sourceSessionKey) ?? "unknown";
  const sourceChannel = normalizeOptionalString(params.sourceChannel) ?? "unknown";
  const sourceEventKey = normalizeOptionalString(params.sourceEventKey);
  const text = normalizeOptionalString(params.payload.text) ?? "[non-text operational notice]";
  return [
    "OpenClaw operational notice",
    `sourceSessionKey: ${sourceSessionKey}`,
    `sourceChannel: ${sourceChannel}`,
    ...(sourceEventKey ? [`sourceEventKey: ${sourceEventKey}`] : []),
    `kind: ${kind}`,
    "",
    text,
  ].join("\n");
}

async function redirectOperationalReply(params: {
  cfg: OpenClawConfig;
  payload: ReplyPayload;
  redirectSessionKey: string;
  sourceChannel?: string;
  sourceEventKey: string;
  sourceSessionKey?: string;
}): Promise<boolean> {
  const idempotencyKey = createOperationalReplyRedirectKey({
    payload: params.payload,
    sourceEventKey: params.sourceEventKey,
    sourceSessionKey: params.sourceSessionKey,
  });
  try {
    const result = await appendAssistantMessageToSessionTranscript({
      sessionKey: params.redirectSessionKey,
      agentId: resolveSessionAgentId({
        sessionKey: params.redirectSessionKey,
        config: params.cfg,
      }),
      text: formatOperationalReplyRedirectText({
        payload: params.payload,
        sourceChannel: params.sourceChannel,
        sourceEventKey: params.sourceEventKey,
        sourceSessionKey: params.sourceSessionKey,
      }),
      idempotencyKey: `operational-reply:${idempotencyKey}`,
      updateMode: "inline",
      config: params.cfg,
      beforeMessageWrite: runAgentHarnessBeforeMessageWriteHook,
    });
    if (!result.ok) {
      logVerbose(`operational-reply-policy: redirect skipped: ${result.reason}`);
      return false;
    }
    return true;
  } catch (error) {
    logVerbose(`operational-reply-policy: redirect failed: ${formatErrorMessage(error)}`);
    return false;
  }
}

function logOperationalReplyPolicySuppression(params: {
  payload: ReplyPayload;
  reason: string;
  sourceSessionKey?: string;
  provider?: string;
  surface?: string;
  chatType?: string;
  inboundEventKind?: string;
  messageKey?: string;
  logPrefix?: string;
}) {
  if (!hasOutboundReplyContent(params.payload, { trimText: true })) {
    return;
  }
  logVerbose(
    [
      `${params.logPrefix ?? "operational-reply-policy"}: operational reply ${params.reason}`,
      `(session=${params.sourceSessionKey ?? "unknown"}`,
      `provider=${params.provider ?? "unknown"}`,
      `surface=${params.surface ?? "unknown"}`,
      `chatType=${params.chatType ?? "unknown"}`,
      `inboundEventKind=${params.inboundEventKind ?? "unknown"}`,
      `message=${params.messageKey ?? "unknown"}`,
      `${formatOperationalReplyPayloadForLog(params.payload)})`,
    ].join(" "),
  );
}

export async function applyOperationalReplyPolicy(params: {
  cfg: OpenClawConfig;
  payload: ReplyPayload;
  explicitCommandTurn: boolean;
  sendPolicyDenied: boolean;
  sourceSessionKey?: string;
  sourceStorePath?: string;
  sourceEventKey: string;
  sourceChannel?: string;
  provider?: string;
  surface?: string;
  chatType?: string;
  inboundEventKind?: string;
  messageKey?: string;
  logPrefix?: string;
}): Promise<OperationalReplyPolicyResult> {
  if (
    !isOperationalReplyPayload({
      payload: params.payload,
      explicitCommandTurn: params.explicitCommandTurn,
    }) ||
    params.sendPolicyDenied
  ) {
    return { shouldDeliver: true };
  }
  const operationalReplyPolicy = resolveOperationalReplyPolicy(params.cfg);
  if (operationalReplyPolicy.policy === "silent") {
    logOperationalReplyPolicySuppression({
      ...params,
      reason: "suppressed by messages.operationalReplies",
    });
    return { intentionalSilence: true, shouldDeliver: false };
  }
  if (operationalReplyPolicy.policy === "once") {
    const onceKey = createOperationalReplyOnceKey({
      payload: params.payload,
      sessionKey: params.sourceSessionKey,
    });
    const reservation = await reserveOperationalReplyOnceKey({
      cfg: params.cfg,
      key: onceKey,
      sourceSessionKey: params.sourceSessionKey,
      sourceStorePath: params.sourceStorePath,
    });
    if (!reservation) {
      logOperationalReplyPolicySuppression({
        ...params,
        reason: "suppressed by messages.operationalReplies once policy",
      });
      return { intentionalSilence: true, shouldDeliver: false };
    }
    return {
      shouldDeliver: true,
      markDelivered: async (delivered) => {
        if (!delivered) {
          await releaseOperationalReplyOnceReservation(reservation);
        } else {
          await finalizeOperationalReplyOnceReservation(reservation);
        }
      },
    };
  }
  if (operationalReplyPolicy.policy === "redirect") {
    let redirected = false;
    if (operationalReplyPolicy.redirectSessionKey) {
      redirected = await redirectOperationalReply({
        cfg: params.cfg,
        payload: params.payload,
        redirectSessionKey: operationalReplyPolicy.redirectSessionKey,
        sourceChannel: params.sourceChannel,
        sourceEventKey: params.sourceEventKey,
        sourceSessionKey: params.sourceSessionKey,
      });
      logOperationalReplyPolicySuppression({
        ...params,
        reason: "redirected by messages.operationalReplies",
      });
    } else {
      logOperationalReplyPolicySuppression({
        ...params,
        reason: "suppressed because messages.operationalReplies redirectSessionKey is missing",
      });
    }
    return { intentionalSilence: true, redirected, shouldDeliver: false };
  }
  return { shouldDeliver: true };
}
