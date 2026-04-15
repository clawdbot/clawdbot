import { normalizeOptionalString } from "./text-runtime.js";

export function isChannelExecApprovalClientEnabledFromConfig(params: {
  enabled?: boolean;
  approverCount?: number;
}): boolean {
  return params.enabled === true && (params.approverCount ?? 0) > 0;
}

export function matchesApprovalRequestFilters(params: {
  request: { agentId?: string | null; sessionKey?: string | null };
  agentFilter?: string[] | null;
  sessionFilter?: string[] | null;
  fallbackAgentIdFromSessionKey?: boolean;
}): boolean {
  const request = params.request ?? {};
  const agentId =
    normalizeOptionalString(request.agentId) ??
    (params.fallbackAgentIdFromSessionKey ? normalizeOptionalString(request.sessionKey) : undefined);
  const sessionKey = normalizeOptionalString(request.sessionKey);

  const agentOk =
    !params.agentFilter?.length || (agentId != null && params.agentFilter.includes(agentId));
  const sessionOk =
    !params.sessionFilter?.length ||
    (sessionKey != null && params.sessionFilter.includes(sessionKey));
  return agentOk && sessionOk;
}

export function isChannelExecApprovalTargetRecipient(params: {
  senderId?: string | null;
  normalizeSenderId?: (value: string | number) => string | undefined;
  matchTarget: (params: { target: { to?: string | null }; normalizedSenderId: string }) => boolean;
  cfg?: unknown;
  accountId?: string | null;
  channel?: string;
}): boolean {
  const normalize =
    params.normalizeSenderId ?? ((value: string | number) => String(value).trim() || undefined);
  const normalizedSenderId =
    params.senderId == null ? undefined : normalize(params.senderId);
  if (!normalizedSenderId) {
    return false;
  }
  return params.matchTarget({ target: { to: params.senderId }, normalizedSenderId });
}

export function createChannelExecApprovalProfile(params: {
  resolveConfig: (params: { cfg: unknown; accountId?: string | null }) => {
    enabled?: boolean;
    approvers?: unknown[];
    agentFilter?: string[];
    sessionFilter?: string[];
    target?: "dm" | "channel" | "both";
  } | undefined;
  resolveApprovers: (params: { cfg: unknown; accountId?: string | null }) => string[];
  normalizeSenderId?: (value: string | number) => string | undefined;
  isTargetRecipient?: (params: { cfg: unknown; senderId?: string | null; accountId?: string | null }) => boolean;
  matchesRequestAccount?: (params: { cfg: unknown; accountId?: string | null; request: unknown }) => boolean;
  fallbackAgentIdFromSessionKey?: boolean;
  requireClientEnabledForLocalPromptSuppression?: boolean;
}) {
  const isApprover = (args: { cfg: unknown; senderId?: string | null; accountId?: string | null }) => {
    const normalize =
      params.normalizeSenderId ?? ((value: string | number) => String(value).trim() || undefined);
    const senderId = args.senderId == null ? undefined : normalize(args.senderId);
    if (!senderId) {
      return false;
    }
    return params.resolveApprovers(args).includes(senderId);
  };

  const isClientEnabled = (args: { cfg: unknown; accountId?: string | null }) => {
    const config = params.resolveConfig(args);
    return isChannelExecApprovalClientEnabledFromConfig({
      enabled: config?.enabled,
      approverCount: params.resolveApprovers(args).length,
    });
  };

  return {
    isClientEnabled,
    isApprover,
    isAuthorizedSender: isApprover,
    resolveTarget: (args: { cfg: unknown; accountId?: string | null }) =>
      params.resolveConfig(args)?.target ?? "dm",
    shouldHandleRequest: (args: { cfg: unknown; accountId?: string | null; request: { request?: { agentId?: string | null; sessionKey?: string | null } } }) => {
      const config = params.resolveConfig(args);
      if (!isClientEnabled(args)) {
        return false;
      }
      if (params.matchesRequestAccount && !params.matchesRequestAccount(args)) {
        return false;
      }
      return matchesApprovalRequestFilters({
        request: args.request.request ?? {},
        agentFilter: config?.agentFilter,
        sessionFilter: config?.sessionFilter,
        fallbackAgentIdFromSessionKey: params.fallbackAgentIdFromSessionKey,
      });
    },
    shouldSuppressLocalPrompt: (args: { cfg: unknown; accountId?: string | null; payload?: unknown }) =>
      params.requireClientEnabledForLocalPromptSuppression === false ? false : isClientEnabled(args),
  };
}
