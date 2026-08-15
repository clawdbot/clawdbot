// Approval auth helpers resolve actor and channel identity for approval requests.
import { normalizeOptionalString } from "../../packages/normalization-core/src/string-coerce.js";
import { resolveApprovalApprovers } from "./approval-approvers.js";
import type { OpenClawConfig } from "./config-runtime.js";

type ApprovalKind = "exec" | "plugin";
type ApproverInput = string | number;
type ApprovalApproverInputs = {
  explicit?: readonly ApproverInput[] | null;
  allowFrom?: readonly ApproverInput[] | null;
  extraAllowFrom?: readonly ApproverInput[] | null;
  defaultTo?: string | null;
};
type ApprovalContext = {
  cfg: OpenClawConfig;
  accountId?: string | null;
};
type ApprovalActorContext = ApprovalContext & {
  senderId?: string | null;
};
type ChannelApprovalAuth = {
  resolveApprovers: (context: ApprovalContext) => string[];
  isAuthorizedSender: (context: ApprovalActorContext) => boolean;
  approvalAuth: ReturnType<typeof createResolvedApproverActionAuthAdapter>;
};
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

// Builds account-scoped approver resolution, sender checks, and action auth.
export function createChannelApprovalAuth(params: {
  channelLabel: string;
  resolveInputs: (params: ApprovalContext) => ApprovalApproverInputs;
  normalizeApprover: (value: ApproverInput) => string | undefined;
  normalizeDefaultTo?: (value: string) => string | undefined;
  normalizeSenderId?: (value: string) => string | undefined;
  isWildcardAuthorized?: (params: {
    purpose: "sender" | "action";
    senderId?: string;
    inputs: ApprovalApproverInputs;
    approvers: readonly string[];
  }) => boolean;
}): ChannelApprovalAuth {
  const normalizeSenderId =
    params.normalizeSenderId ?? ((value: string) => params.normalizeApprover(value));
  const resolveApprovers = (context: ApprovalContext): string[] => {
    const inputs = params.resolveInputs(context);
    return resolveApprovalApprovers({
      ...inputs,
      normalizeApprover: params.normalizeApprover,
      normalizeDefaultTo: params.normalizeDefaultTo,
    });
  };
  const isAuthorizedSender = (context: ApprovalActorContext): boolean => {
    const inputs = params.resolveInputs(context);
    const approvers = resolveApprovalApprovers({
      ...inputs,
      normalizeApprover: params.normalizeApprover,
      normalizeDefaultTo: params.normalizeDefaultTo,
    });
    const senderId = context.senderId ? normalizeSenderId(context.senderId) : undefined;
    if (
      params.isWildcardAuthorized?.({ purpose: "sender", senderId, inputs, approvers }) === true
    ) {
      return true;
    }
    return Boolean(senderId && approvers.includes(senderId));
  };
  return {
    resolveApprovers,
    isAuthorizedSender,
    approvalAuth: {
      authorizeActorAction(input: {
        cfg: OpenClawConfig;
        accountId?: string | null;
        senderId?: string | null;
        action: "approve";
        approvalKind: ApprovalKind;
      }) {
        const inputs = params.resolveInputs(input);
        const approvers = resolveApprovalApprovers({
          ...inputs,
          normalizeApprover: params.normalizeApprover,
          normalizeDefaultTo: params.normalizeDefaultTo,
        });
        const senderId = input.senderId ? normalizeSenderId(input.senderId) : undefined;
        if (
          params.isWildcardAuthorized?.({ purpose: "action", senderId, inputs, approvers }) === true
        ) {
          return { authorized: true } as const;
        }
        if (approvers.length === 0) {
          // Empty approver sets are implicit same-chat fallback, not explicit approver bypass.
          return markImplicitSameChatApprovalAuthorization({ authorized: true });
        }
        if (senderId && approvers.includes(senderId)) {
          return { authorized: true } as const;
        }
        return {
          authorized: false,
          reason: `❌ You are not authorized to approve ${input.approvalKind} requests on ${params.channelLabel}.`,
        } as const;
      },
    },
  };
}
