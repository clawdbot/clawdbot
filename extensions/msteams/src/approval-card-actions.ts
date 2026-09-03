import crypto from "node:crypto";
import type { ChannelApprovalKind } from "openclaw/plugin-sdk/approval-handler-runtime";
import type { ExecApprovalDecision } from "openclaw/plugin-sdk/approval-runtime";
import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";
import {
  isRecord,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";

export type MSTeamsApprovalCardBinding = {
  token: string;
  accountId: string;
  approvalId: string;
  approvalKind: ChannelApprovalKind;
  decision: ExecApprovalDecision;
  allowedDecisions: readonly ExecApprovalDecision[];
  conversationId: string;
  activityId: string;
  expiresAtMs: number;
};

type MSTeamsApprovalCardClaim =
  | { kind: "claimed"; binding: MSTeamsApprovalCardBinding }
  | { kind: "missing" }
  | { kind: "in-flight" };

const approvalCardBindings = new Map<string, MSTeamsApprovalCardBinding>();
const approvalCardResolvingTokens = new Set<string>();
const MSTEAMS_APPROVAL_CARD_BINDING_MAX_ENTRIES = 1024;

export function createMSTeamsApprovalToken(): string {
  return crypto.randomBytes(18).toString("base64url");
}

export function readMSTeamsApprovalActionToken(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  const action = isRecord(value.action) ? value.action : undefined;
  const submitted =
    action &&
    normalizeOptionalLowercaseString(action.type) === "action.submit" &&
    isRecord(action.data)
      ? action.data
      : value;
  if (submitted.openclawAction !== "approval") {
    return null;
  }
  return normalizeOptionalString(submitted.token) ?? null;
}

export function registerMSTeamsApprovalCardBinding(binding: MSTeamsApprovalCardBinding): boolean {
  if (binding.expiresAtMs <= Date.now()) {
    return false;
  }
  approvalCardBindings.delete(binding.token);
  approvalCardBindings.set(binding.token, binding);
  pruneMapToMaxSize(approvalCardBindings, MSTEAMS_APPROVAL_CARD_BINDING_MAX_ENTRIES);
  return true;
}

export function getMSTeamsApprovalCardBinding(token: string): MSTeamsApprovalCardBinding | null {
  const binding = approvalCardBindings.get(token);
  if (!binding) {
    return null;
  }
  if (binding.expiresAtMs <= Date.now()) {
    approvalCardBindings.delete(token);
    approvalCardResolvingTokens.delete(token);
    return null;
  }
  return binding;
}

export function claimMSTeamsApprovalCardBinding(token: string): MSTeamsApprovalCardClaim {
  const binding = getMSTeamsApprovalCardBinding(token);
  if (!binding) {
    return { kind: "missing" };
  }
  if (approvalCardResolvingTokens.has(token)) {
    return { kind: "in-flight" };
  }
  // Keep the claim until resolution completes or fails so concurrent submits cannot resolve twice.
  approvalCardResolvingTokens.add(token);
  return { kind: "claimed", binding };
}

export function completeMSTeamsApprovalCardBinding(token: string): void {
  approvalCardResolvingTokens.delete(token);
  approvalCardBindings.delete(token);
}

export function releaseMSTeamsApprovalCardBinding(token: string): void {
  approvalCardResolvingTokens.delete(token);
}

export function unregisterMSTeamsApprovalCardBindings(tokens: readonly string[]): void {
  for (const token of tokens) {
    completeMSTeamsApprovalCardBinding(token);
  }
}
