import type { ChannelApprovalKind } from "openclaw/plugin-sdk/approval-handler-runtime";
import {
  createNativeApprovalControlRegistry,
  type ExecApprovalDecision,
} from "openclaw/plugin-sdk/approval-runtime";
import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { GoogleChatActionParameter, GoogleChatEvent } from "./types.js";

export const GOOGLECHAT_APPROVAL_ACTION = "openclaw.approval";
const GOOGLECHAT_APPROVAL_ACTION_PARAM = "openclaw_action";
const GOOGLECHAT_APPROVAL_TOKEN_PARAM = "token";
const GOOGLECHAT_APPROVAL_ACTION_VALUE = "approval";
const MANUAL_EXEC_APPROVAL_COMMAND_RE =
  /(?:^|[\s`])\/approve[ \t]+([^ \t\r\n`|]+)[ \t]+(allow-once|allow-always|deny)(?=$|[\s`|.,;:!?])/giu;

type GoogleChatApprovalCardBinding = {
  token: string;
  accountId: string;
  approvalId: string;
  approvalKind: ChannelApprovalKind;
  decision: ExecApprovalDecision;
  allowedDecisions: readonly ExecApprovalDecision[];
  spaceName: string;
  messageName: string;
  threadName?: string | null;
  expiresAtMs: number;
};

export const googleChatApprovalControls =
  createNativeApprovalControlRegistry<GoogleChatApprovalCardBinding>({
    releaseClaimOnLookupExpiry: false,
    onComplete: (binding) =>
      unregisterGoogleChatManualApprovalFollowupSuppression(binding.approvalId),
  });
const GOOGLECHAT_MANUAL_APPROVAL_SUPPRESSION_MAX_ENTRIES = 1024;

type GoogleChatManualApprovalSuppressionPayload = {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  presentation?: unknown;
  interactive?: unknown;
  channelData?: unknown;
  btw?: unknown;
  spokenText?: unknown;
  ttsSupplement?: unknown;
};

type GoogleChatManualApprovalFollowupSuppression = {
  approvalId: string;
  approvalKind: ChannelApprovalKind;
  allowedDecisions: readonly ExecApprovalDecision[];
  expiresAtMs: number;
};

const manualApprovalFollowupSuppressions = new Map<
  string,
  GoogleChatManualApprovalFollowupSuppression
>();

export function buildGoogleChatApprovalActionParameters(
  token: string,
): GoogleChatActionParameter[] {
  return [
    { key: GOOGLECHAT_APPROVAL_ACTION_PARAM, value: GOOGLECHAT_APPROVAL_ACTION_VALUE },
    { key: GOOGLECHAT_APPROVAL_TOKEN_PARAM, value: token },
  ];
}

function collectEventParameters(event: GoogleChatEvent): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(event.common?.parameters ?? {})) {
    if (typeof value === "string") {
      params[key] = value;
    }
  }
  for (const [key, value] of Object.entries(event.commonEventObject?.parameters ?? {})) {
    if (typeof value === "string") {
      params[key] = value;
    }
  }
  for (const item of event.action?.parameters ?? []) {
    if (typeof item.key === "string" && typeof item.value === "string") {
      params[item.key] = item.value;
    }
  }
  return params;
}

export function readGoogleChatApprovalActionToken(event: GoogleChatEvent): string | null {
  const params = collectEventParameters(event);
  if (params[GOOGLECHAT_APPROVAL_ACTION_PARAM] !== GOOGLECHAT_APPROVAL_ACTION_VALUE) {
    return null;
  }
  const actionName =
    normalizeOptionalString(event.action?.actionMethodName) ??
    normalizeOptionalString(event.common?.invokedFunction) ??
    normalizeOptionalString(event.commonEventObject?.invokedFunction);
  if (
    actionName &&
    actionName !== GOOGLECHAT_APPROVAL_ACTION &&
    !actionName.startsWith("https://")
  ) {
    return null;
  }
  return normalizeOptionalString(params[GOOGLECHAT_APPROVAL_TOKEN_PARAM]) ?? null;
}

export function registerGoogleChatApprovalCardBinding(
  binding: GoogleChatApprovalCardBinding,
): boolean {
  if (!googleChatApprovalControls.register(binding)) {
    return false;
  }
  registerGoogleChatManualApprovalFollowupSuppression({
    approvalId: binding.approvalId,
    approvalKind: binding.approvalKind,
    allowedDecisions: binding.allowedDecisions,
    expiresAtMs: binding.expiresAtMs,
  });
  return true;
}

function normalizeApprovalRef(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return normalized ? normalized : null;
}

function manualApprovalFollowupSuppressionKey(approvalId: string): string | null {
  return normalizeApprovalRef(approvalId);
}

export function registerGoogleChatManualApprovalFollowupSuppression(
  suppression: GoogleChatManualApprovalFollowupSuppression,
): boolean {
  if (suppression.expiresAtMs <= Date.now()) {
    return false;
  }
  const key = manualApprovalFollowupSuppressionKey(suppression.approvalId);
  if (!key) {
    return false;
  }
  if (manualApprovalFollowupSuppressions.has(key)) {
    manualApprovalFollowupSuppressions.delete(key);
  }
  manualApprovalFollowupSuppressions.set(key, suppression);
  pruneMapToMaxSize(
    manualApprovalFollowupSuppressions,
    GOOGLECHAT_MANUAL_APPROVAL_SUPPRESSION_MAX_ENTRIES,
  );
  return true;
}

export function unregisterGoogleChatManualApprovalFollowupSuppression(approvalId: string): void {
  const key = manualApprovalFollowupSuppressionKey(approvalId);
  if (key) {
    manualApprovalFollowupSuppressions.delete(key);
  }
}

function approvalRefMatches(bindingApprovalId: string, approvalRef: string): boolean {
  const normalizedBindingId = normalizeApprovalRef(bindingApprovalId);
  const normalizedRef = normalizeApprovalRef(approvalRef);
  if (!normalizedBindingId || !normalizedRef) {
    return false;
  }
  return (
    normalizedRef === normalizedBindingId ||
    (normalizedRef.length >= 8 && normalizedBindingId.startsWith(normalizedRef))
  );
}

function pruneExpiredGoogleChatApprovalCardBindings(nowMs: number): void {
  googleChatApprovalControls.pruneExpired(nowMs);
  for (const [approvalId, suppression] of manualApprovalFollowupSuppressions) {
    if (suppression.expiresAtMs <= nowMs) {
      manualApprovalFollowupSuppressions.delete(approvalId);
    }
  }
}

function hasActiveGoogleChatExecApprovalCardForManualCommand(params: {
  approvalRef: string;
  decision: ExecApprovalDecision;
  nowMs: number;
}): boolean {
  pruneExpiredGoogleChatApprovalCardBindings(params.nowMs);
  for (const binding of googleChatApprovalControls.values()) {
    if (
      binding.approvalKind === "exec" &&
      binding.allowedDecisions.includes(params.decision) &&
      approvalRefMatches(binding.approvalId, params.approvalRef)
    ) {
      return true;
    }
  }
  for (const suppression of manualApprovalFollowupSuppressions.values()) {
    if (
      suppression.approvalKind === "exec" &&
      suppression.allowedDecisions.includes(params.decision) &&
      approvalRefMatches(suppression.approvalId, params.approvalRef)
    ) {
      return true;
    }
  }
  return false;
}

export function shouldSuppressGoogleChatManualExecApprovalFollowupText(
  text: string,
  nowMs = Date.now(),
): boolean {
  for (const match of text.matchAll(MANUAL_EXEC_APPROVAL_COMMAND_RE)) {
    const approvalRef = match[1];
    const decision = match[2]?.toLowerCase() as ExecApprovalDecision | undefined;
    if (
      approvalRef &&
      decision &&
      hasActiveGoogleChatExecApprovalCardForManualCommand({ approvalRef, decision, nowMs })
    ) {
      return true;
    }
  }
  return false;
}

function hasSendableMedia(payload: GoogleChatManualApprovalSuppressionPayload): boolean {
  return Boolean(payload.mediaUrl?.trim() || payload.mediaUrls?.some((url) => url.trim()));
}

function hasStructuredPayloadPart(payload: GoogleChatManualApprovalSuppressionPayload): boolean {
  return Boolean(
    hasSendableMedia(payload) ||
    payload.presentation ||
    payload.interactive ||
    payload.btw ||
    payload.spokenText ||
    payload.ttsSupplement,
  );
}

export function shouldSuppressGoogleChatManualExecApprovalFollowupPayload(
  payload: GoogleChatManualApprovalSuppressionPayload,
  nowMs = Date.now(),
): boolean {
  const text = payload.text?.trim();
  if (!text || hasStructuredPayloadPart(payload)) {
    return false;
  }
  return shouldSuppressGoogleChatManualExecApprovalFollowupText(text, nowMs);
}
