import { resolveApprovalApprovers } from "openclaw/plugin-sdk/approval-auth-runtime";
import {
  createChannelExecApprovalProfile,
  getExecApprovalReplyMetadata,
  isChannelExecApprovalClientEnabledFromConfig,
  isChannelExecApprovalTargetRecipient,
  matchesApprovalRequestFilters,
} from "openclaw/plugin-sdk/approval-client-runtime";
import { resolveApprovalRequestChannelAccountId } from "openclaw/plugin-sdk/approval-native-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { ExecApprovalRequest, PluginApprovalRequest } from "openclaw/plugin-sdk/infra-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { normalizeAccountId } from "openclaw/plugin-sdk/routing";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { getMatrixApprovalAuthApprovers } from "./approval-auth.js";
import { normalizeMatrixApproverId } from "./approval-ids.js";
import { listMatrixAccountIds, resolveMatrixAccount } from "./matrix/accounts.js";
import type { CoreConfig } from "./types.js";

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;
type ApprovalKind = "exec" | "plugin";

export { normalizeMatrixApproverId };

function normalizeMatrixExecApproverId(value: string | number): string | undefined {
  const normalized = normalizeMatrixApproverId(value);
  return normalized === "*" ? undefined : normalized;
}

function resolveMatrixExecApprovalConfig(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}) {
  const account = resolveMatrixAccount(params);
  const config = account.config.execApprovals;
  if (!config) {
    return undefined;
  }
  return {
    ...config,
    enabled: account.enabled && account.configured ? config.enabled : false,
  };
}

function countMatrixExecApprovalEligibleAccounts(params: {
  cfg: OpenClawConfig;
  request: ApprovalRequest;
  approvalKind: ApprovalKind;
}): number {
  return listMatrixAccountIds(params.cfg).filter((accountId) => {
    const account = resolveMatrixAccount({ cfg: params.cfg, accountId });
    if (!account.enabled || !account.configured) {
      return false;
    }
    const config = resolveMatrixExecApprovalConfig({
      cfg: params.cfg,
      accountId,
    });
    const filters = config?.enabled
      ? {
          agentFilter: config.agentFilter,
          sessionFilter: config.sessionFilter,
        }
      : {
          agentFilter: undefined,
          sessionFilter: undefined,
        };
    return (
      isChannelExecApprovalClientEnabledFromConfig({
        enabled: config?.enabled,
        approverCount: getMatrixApprovalApprovers({
          cfg: params.cfg,
          accountId,
          approvalKind: params.approvalKind,
        }).length,
      }) &&
      matchesApprovalRequestFilters({
        request: params.request.request,
        agentFilter: filters.agentFilter,
        sessionFilter: filters.sessionFilter,
      })
    );
  }).length;
}

function matchesMatrixRequestAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  request: ApprovalRequest;
  approvalKind: ApprovalKind;
}): boolean {
  const turnSourceChannel = normalizeLowercaseStringOrEmpty(
    params.request.request.turnSourceChannel,
  );
  const boundAccountId = resolveApprovalRequestChannelAccountId({
    cfg: params.cfg,
    request: params.request,
    channel: "matrix",
  });
  if (turnSourceChannel && turnSourceChannel !== "matrix" && !boundAccountId) {
    return (
      countMatrixExecApprovalEligibleAccounts({
        cfg: params.cfg,
        request: params.request,
        approvalKind: params.approvalKind,
      }) <= 1
    );
  }
  return (
    !boundAccountId ||
    !params.accountId ||
    normalizeAccountId(boundAccountId) === normalizeAccountId(params.accountId)
  );
}

export function getMatrixExecApprovalApprovers(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): string[] {
  const account = resolveMatrixAccount(params).config;
  return resolveApprovalApprovers({
    explicit: account.execApprovals?.approvers,
    allowFrom: account.dm?.allowFrom,
    normalizeApprover: normalizeMatrixExecApproverId,
  });
}

function resolveMatrixApprovalKind(request: ApprovalRequest): ApprovalKind {
  return request.id.startsWith("plugin:") ? "plugin" : "exec";
}

export function getMatrixApprovalApprovers(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  approvalKind: ApprovalKind;
}): string[] {
  if (params.approvalKind === "plugin") {
    return getMatrixApprovalAuthApprovers({
      cfg: params.cfg as CoreConfig,
      accountId: params.accountId,
    });
  }
  return getMatrixExecApprovalApprovers(params);
}

export function isMatrixExecApprovalTargetRecipient(params: {
  cfg: OpenClawConfig;
  senderId?: string | null;
  accountId?: string | null;
}): boolean {
  return isChannelExecApprovalTargetRecipient({
    ...params,
    channel: "matrix",
    normalizeSenderId: normalizeMatrixApproverId,
    matchTarget: ({ target, normalizedSenderId }) =>
      normalizeMatrixApproverId(target.to) === normalizedSenderId,
  });
}

const matrixExecApprovalProfile = createChannelExecApprovalProfile({
  resolveConfig: resolveMatrixExecApprovalConfig,
  resolveApprovers: getMatrixExecApprovalApprovers,
  normalizeSenderId: normalizeMatrixApproverId,
  isTargetRecipient: isMatrixExecApprovalTargetRecipient,
  matchesRequestAccount: (params) =>
    matchesMatrixRequestAccount({
      ...params,
      approvalKind: "exec",
    }),
});

export const isMatrixExecApprovalClientEnabled = matrixExecApprovalProfile.isClientEnabled;
export const isMatrixExecApprovalApprover = matrixExecApprovalProfile.isApprover;
export const isMatrixExecApprovalAuthorizedSender = matrixExecApprovalProfile.isAuthorizedSender;
export const resolveMatrixExecApprovalTarget = matrixExecApprovalProfile.resolveTarget;
export const shouldHandleMatrixExecApprovalRequest = matrixExecApprovalProfile.shouldHandleRequest;

export function isMatrixApprovalClientEnabled(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  approvalKind: ApprovalKind;
}): boolean {
  if (params.approvalKind === "exec") {
    return isMatrixExecApprovalClientEnabled(params);
  }
  const config = resolveMatrixExecApprovalConfig(params);
  return isChannelExecApprovalClientEnabledFromConfig({
    enabled: config?.enabled,
    approverCount: getMatrixApprovalApprovers(params).length,
  });
}

export function isMatrixAnyApprovalClientEnabled(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean {
  return (
    isMatrixApprovalClientEnabled({
      ...params,
      approvalKind: "exec",
    }) ||
    isMatrixApprovalClientEnabled({
      ...params,
      approvalKind: "plugin",
    })
  );
}

export function shouldHandleMatrixApprovalRequest(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  request: ApprovalRequest;
}): boolean {
  const approvalKind = resolveMatrixApprovalKind(params.request);
  if (
    !matchesMatrixRequestAccount({
      ...params,
      approvalKind,
    })
  ) {
    return false;
  }
  const config = resolveMatrixExecApprovalConfig(params);
  if (
    !isChannelExecApprovalClientEnabledFromConfig({
      enabled: config?.enabled,
      approverCount: getMatrixApprovalApprovers({
        ...params,
        approvalKind,
      }).length,
    })
  ) {
    return false;
  }
  return matchesApprovalRequestFilters({
    request: params.request.request,
    agentFilter: config?.agentFilter,
    sessionFilter: config?.sessionFilter,
  });
}

function buildFilterCheckRequest(params: {
  metadata: NonNullable<ReturnType<typeof getExecApprovalReplyMetadata>>;
}): ApprovalRequest {
  if (params.metadata.approvalKind === "plugin") {
    return {
      id: params.metadata.approvalId,
      request: {
        title: "Plugin Approval Required",
        description: "",
        agentId: params.metadata.agentId ?? null,
        sessionKey: params.metadata.sessionKey ?? null,
      },
      createdAtMs: 0,
      expiresAtMs: 0,
    };
  }
  return {
    id: params.metadata.approvalId,
    request: {
      command: "",
      agentId: params.metadata.agentId ?? null,
      sessionKey: params.metadata.sessionKey ?? null,
    },
    createdAtMs: 0,
    expiresAtMs: 0,
  };
}

export function shouldSuppressLocalMatrixExecApprovalPrompt(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  payload: ReplyPayload;
}): boolean {
  if (!matrixExecApprovalProfile.shouldSuppressLocalPrompt(params)) {
    return false;
  }
  const metadata = getExecApprovalReplyMetadata(params.payload);
  if (!metadata) {
    return false;
  }
  const request = buildFilterCheckRequest({
    metadata,
  });
  return shouldHandleMatrixApprovalRequest({
    cfg: params.cfg,
    accountId: params.accountId,
    request,
  });
}
