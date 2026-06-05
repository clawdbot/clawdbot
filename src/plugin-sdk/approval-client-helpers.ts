// Approval client helpers build approval URLs and status payloads for plugin clients.
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../../packages/normalization-core/src/string-coerce.js";
import type { ExecApprovalForwardTarget } from "../config/types.approvals.js";
import { matchesApprovalRequestFilters } from "../infra/approval-request-filters.js";
import { getExecApprovalReplyMetadata } from "../infra/exec-approval-reply.js";
import type { ExecApprovalRequest } from "../infra/exec-approvals.js";
import type { PluginApprovalRequest } from "../infra/plugin-approvals.js";
import type { OpenClawConfig } from "./config-runtime.js";
import type { ReplyPayload } from "./reply-payload.js";
import { normalizeAccountId } from "./routing.js";

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;
type ApprovalTarget = "dm" | "channel" | "both";
type ChannelExecApprovalEnableMode = boolean | "auto";

type ChannelApprovalConfig = {
  /** Whether the channel approval client is enabled for this account. */
  enabled?: ChannelExecApprovalEnableMode;
  /** Preferred approval delivery target for this account. */
  target?: ApprovalTarget;
  /** Optional agent filters for forwarded approval requests. */
  agentFilter?: string[];
  /** Optional session filters for forwarded approval requests. */
  sessionFilter?: string[];
};

type ApprovalProfileParams = {
  /** Full config used to resolve account-scoped approval settings. */
  cfg: OpenClawConfig;
  /** Optional channel account id for account-scoped approval settings. */
  accountId?: string | null;
};

function isApprovalTargetsMode(cfg: OpenClawConfig): boolean {
  const execApprovals = cfg.approvals?.exec;
  if (!execApprovals?.enabled) {
    return false;
  }
  return execApprovals.mode === "targets" || execApprovals.mode === "both";
}

export { getExecApprovalReplyMetadata, matchesApprovalRequestFilters };

/** Return whether a channel account has an enabled approval client and at least one approver. */
export function isChannelExecApprovalClientEnabledFromConfig(params: {
  /** Configured channel approval enable mode. */
  enabled?: ChannelExecApprovalEnableMode;
  /** Number of configured approvers after account resolution. */
  approverCount: number;
}): boolean {
  if (params.approverCount <= 0) {
    return false;
  }
  return params.enabled === true || params.enabled === "auto";
}

/**
 * Return whether a sender is one of the configured global exec approval forward targets.
 * Channel plugins provide the target matcher because `to` shapes differ by provider.
 */
export function isChannelExecApprovalTargetRecipient(params: {
  /** Full config containing global exec approval target routing. */
  cfg: OpenClawConfig;
  /** Sender id or handle to compare with configured forward targets. */
  senderId?: string | null;
  /** Optional channel account id for account-scoped target matching. */
  accountId?: string | null;
  /** Channel id receiving the approval action. */
  channel: string;
  /** Optional sender normalizer; defaults to trimmed string normalization. */
  normalizeSenderId?: (value: string) => string | undefined;
  /** Channel-specific matcher for normalized sender ids against target records. */
  matchTarget: (params: {
    target: ExecApprovalForwardTarget;
    normalizedSenderId: string;
    normalizedAccountId?: string;
  }) => boolean;
}): boolean {
  const normalizeSenderId = params.normalizeSenderId ?? normalizeOptionalString;
  const normalizedSenderId = params.senderId ? normalizeSenderId(params.senderId) : undefined;
  const normalizedChannel = normalizeOptionalLowercaseString(params.channel);
  if (!normalizedSenderId || !isApprovalTargetsMode(params.cfg)) {
    return false;
  }
  const targets = params.cfg.approvals?.exec?.targets;
  if (!targets) {
    return false;
  }
  const normalizedAccountId = params.accountId ? normalizeAccountId(params.accountId) : undefined;
  return targets.some((target) => {
    if (normalizeOptionalLowercaseString(target.channel) !== normalizedChannel) {
      return false;
    }
    // Account-scoped targets only match the same account; targets without accountId stay global.
    if (
      normalizedAccountId &&
      target.accountId &&
      normalizeAccountId(target.accountId) !== normalizedAccountId
    ) {
      return false;
    }
    return params.matchTarget({
      target,
      normalizedSenderId,
      normalizedAccountId,
    });
  });
}

/**
 * Build the common approval-client profile used by channel plugins.
 * The returned helpers centralize enablement, approver auth, request filters, and local prompt suppression.
 */
export function createChannelExecApprovalProfile(params: {
  /** Resolves channel approval config for the current account. */
  resolveConfig: (params: ApprovalProfileParams) => ChannelApprovalConfig | undefined;
  /** Resolves normalized approver ids for the current account. */
  resolveApprovers: (params: ApprovalProfileParams) => string[];
  /** Optional sender normalizer; defaults to trimmed string normalization. */
  normalizeSenderId?: (value: string) => string | undefined;
  /** Optional global approval-target matcher for sender authorization. */
  isTargetRecipient?: (params: ApprovalProfileParams & { senderId?: string | null }) => boolean;
  /** Optional account matcher for filtering forwarded approval requests. */
  matchesRequestAccount?: (params: ApprovalProfileParams & { request: ApprovalRequest }) => boolean;
  // Some channels encode the effective agent only in sessionKey for forwarded approvals.
  fallbackAgentIdFromSessionKey?: boolean;
  /** Allows local prompt suppression even when the remote approval client is disabled. */
  requireClientEnabledForLocalPromptSuppression?: boolean;
}) {
  const normalizeSenderId = params.normalizeSenderId ?? normalizeOptionalString;

  const isClientEnabled = (input: ApprovalProfileParams): boolean => {
    const config = params.resolveConfig(input);
    return isChannelExecApprovalClientEnabledFromConfig({
      enabled: config?.enabled,
      approverCount: params.resolveApprovers(input).length,
    });
  };

  const isApprover = (input: ApprovalProfileParams & { senderId?: string | null }): boolean => {
    const normalizedSenderId = input.senderId ? normalizeSenderId(input.senderId) : undefined;
    if (!normalizedSenderId) {
      return false;
    }
    return params.resolveApprovers(input).includes(normalizedSenderId);
  };

  const isAuthorizedSender = (
    input: ApprovalProfileParams & { senderId?: string | null },
  ): boolean => {
    return isApprover(input) || (params.isTargetRecipient?.(input) ?? false);
  };

  const resolveTarget = (input: ApprovalProfileParams): ApprovalTarget => {
    return params.resolveConfig(input)?.target ?? "dm";
  };

  const shouldHandleRequest = (
    input: ApprovalProfileParams & { request: ApprovalRequest },
  ): boolean => {
    if (params.matchesRequestAccount && !params.matchesRequestAccount(input)) {
      return false;
    }
    const config = params.resolveConfig(input);
    const approverCount = params.resolveApprovers(input).length;
    if (
      !isChannelExecApprovalClientEnabledFromConfig({
        enabled: config?.enabled,
        approverCount,
      })
    ) {
      return false;
    }
    return matchesApprovalRequestFilters({
      request: input.request.request,
      agentFilter: config?.agentFilter,
      sessionFilter: config?.sessionFilter,
      fallbackAgentIdFromSessionKey: params.fallbackAgentIdFromSessionKey === true,
    });
  };

  const shouldSuppressLocalPrompt = (
    input: ApprovalProfileParams & { payload: ReplyPayload },
  ): boolean => {
    if (params.requireClientEnabledForLocalPromptSuppression !== false && !isClientEnabled(input)) {
      return false;
    }
    return getExecApprovalReplyMetadata(input.payload) !== null;
  };

  return {
    /** Whether this account has an enabled channel approval client and approvers. */
    isClientEnabled,
    /** Whether a sender is in the resolved approver set. */
    isApprover,
    /** Whether a sender is either an approver or a configured approval target. */
    isAuthorizedSender,
    /** Preferred delivery target, defaulting to approver DMs. */
    resolveTarget,
    /** Whether this profile should handle a forwarded approval request. */
    shouldHandleRequest,
    /** Whether a local approval prompt should be suppressed for an already-rendered payload. */
    shouldSuppressLocalPrompt,
  };
}
