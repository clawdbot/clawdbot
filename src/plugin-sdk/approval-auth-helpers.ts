// Approval auth helpers resolve actor and channel identity for approval requests.
import { normalizeOptionalString } from "../../packages/normalization-core/src/string-coerce.js";
import type { OpenClawConfig } from "./config-runtime.js";

type ApprovalKind = "exec" | "plugin";
type ApprovalAuthorizationResult = {
  /** Whether the actor may perform the approval action. */
  authorized: boolean;
  /** User-facing denial reason when authorization fails. */
  reason?: string;
};
const IMPLICIT_SAME_CHAT_APPROVAL_AUTHORIZATION = Symbol(
  "openclaw.implicitSameChatApprovalAuthorization",
);

/**
 * Marks an authorization result as the implicit same-chat fallback used when a
 * channel has no configured approver allowlist.
 */
export function markImplicitSameChatApprovalAuthorization(
  /** Authorization result to tag as the empty-approver same-chat fallback. */
  result: ApprovalAuthorizationResult,
): ApprovalAuthorizationResult {
  // Keep this non-enumerable to avoid changing auth payload shape.
  // Consumers must pass the same object reference to
  // `isImplicitSameChatApprovalAuthorization`; spread/Object.assign/JSON clones
  // drop this marker.
  Object.defineProperty(result, IMPLICIT_SAME_CHAT_APPROVAL_AUTHORIZATION, {
    value: true,
    enumerable: false,
  });
  return result;
}

/**
 * Checks whether an authorization result came from the implicit same-chat
 * fallback instead of an explicitly configured approver allowlist.
 */
export function isImplicitSameChatApprovalAuthorization(
  /** Authorization result returned by approval auth helpers. */
  result: ApprovalAuthorizationResult | null | undefined,
): boolean {
  return Boolean(
    result &&
    (
      result as ApprovalAuthorizationResult & {
        [IMPLICIT_SAME_CHAT_APPROVAL_AUTHORIZATION]?: true;
      }
    )[IMPLICIT_SAME_CHAT_APPROVAL_AUTHORIZATION],
  );
}

/**
 * Builds the approval authorization adapter shared by channels that resolve
 * approvers from account-scoped config.
 */
export function createResolvedApproverActionAuthAdapter(params: {
  /** Human-readable channel label used in denial messages. */
  channelLabel: string;
  /** Resolves normalized approver ids from config and optional account scope. */
  resolveApprovers: (params: { cfg: OpenClawConfig; accountId?: string | null }) => string[];
  /** Optional sender normalizer; defaults to trimmed string normalization. */
  normalizeSenderId?: (value: string) => string | undefined;
}) {
  const normalizeSenderId = params.normalizeSenderId ?? normalizeOptionalString;

  return {
    authorizeActorAction({
      cfg,
      accountId,
      senderId,
      approvalKind,
    }: {
      /** Full config used to resolve account-scoped approvers. */
      cfg: OpenClawConfig;
      /** Optional channel account id for account-scoped approver config. */
      accountId?: string | null;
      /** Actor attempting the approval action. */
      senderId?: string | null;
      /** Approval action being authorized. */
      action: "approve";
      /** Approval kind used in user-facing denial copy. */
      approvalKind: ApprovalKind;
    }) {
      const approvers = params.resolveApprovers({ cfg, accountId });
      if (approvers.length === 0) {
        // Empty approver sets are implicit same-chat fallback, not explicit approver bypass.
        return markImplicitSameChatApprovalAuthorization({ authorized: true });
      }
      const normalizedSenderId = senderId ? normalizeSenderId(senderId) : undefined;
      if (normalizedSenderId && approvers.includes(normalizedSenderId)) {
        return { authorized: true } as const;
      }
      return {
        authorized: false,
        reason: `❌ You are not authorized to approve ${approvalKind} requests on ${params.channelLabel}.`,
      } as const;
    },
  };
}
