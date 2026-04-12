import type { ReplyPayload } from "../auto-reply/reply-payload.js";
import type { ExecApprovalForwardTarget } from "../config/types.approvals.js";
import { matchesApprovalRequestFilters } from "../infra/approval-request-filters.js";
import { getExecApprovalReplyMetadata } from "../infra/exec-approval-reply.js";
import type { ExecApprovalRequest } from "../infra/exec-approvals.js";
import type { PluginApprovalRequest } from "../infra/plugin-approvals.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import type { OpenClawConfig } from "./config-runtime.js";
import { normalizeAccountId } from "./routing.js";

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;
type ApprovalTarget = "dm" | "channel" | "both";
type ChannelExecApprovalEnableMode = boolean | "auto";

type ChannelApprovalConfig = {
  enabled?: ChannelExecApprovalEnableMode;
  target?: ApprovalTarget;
  agentFilter?: string[];
  sessionFilter?: string[];
};

type ApprovalProfileParams = {
  cfg: OpenClawConfig;
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

export function isChannelExecApprovalClientEnabledFromConfig(params: {
  enabled?: ChannelExecApprovalEnableMode;
  approverCount: number;
}): boolean {
  if (params.approverCount <= 0) {
    return false;
  }
  return params.enabled !== false;
}

export function isChannelExecApprovalTargetRecipient(params: {
  cfg: OpenClawConfig;
  senderId?: string | null;
  accountId?: string | null;
  channel: string;
  normalizeSenderId?: (value: string) => string | undefined;
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

export function createChannelExecApprovalProfile(params: {
  resolveConfig: (params: ApprovalProfileParams) => ChannelApprovalConfig | undefined;
  resolveApprovers: (params: ApprovalProfileParams) => string[];
  normalizeSenderId?: (value: string) => string | undefined;
  isTargetRecipient?: (params: ApprovalProfileParams & { senderId?: string | null }) => boolean;
  matchesRequestAccount?: (params: ApprovalProfileParams & { request: ApprovalRequest }) => boolean;
  // Some channels encode the effective agent only in sessionKey for forwarded approvals.
  fallbackAgentIdFromSessionKey?: boolean;
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
    isClientEnabled,
    isApprover,
    isAuthorizedSender,
    resolveTarget,
    shouldHandleRequest,
    shouldSuppressLocalPrompt,
  };
}
