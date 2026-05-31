import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { compileSafeRegex, testRegexWithBoundedInput } from "../security/safe-regex.js";

export type ApprovalRequestFilterInput = {
  agentId?: string | null;
  sessionKey?: string | null;
};

export function matchesApprovalRequestSessionFilter(
  sessionKey: string,
  patterns: string[],
): boolean {
  return patterns.some((pattern) => {
    if (sessionKey.includes(pattern)) {
      return true;
    }
    const regex = compileSafeRegex(pattern);
    return regex ? testRegexWithBoundedInput(regex, sessionKey) : false;
  });
}

export function matchesApprovalRequestFilters(params: {
  request: ApprovalRequestFilterInput;
  agentFilter?: string[];
  sessionFilter?: string[];
  fallbackAgentIdFromSessionKey?: boolean;
}): boolean {
  if (params.agentFilter?.length) {
    const explicitAgentId = normalizeOptionalString(params.request.agentId);
    const sessionAgentId = params.fallbackAgentIdFromSessionKey
      ? (parseAgentSessionKey(params.request.sessionKey)?.agentId ?? undefined)
      : undefined;
    const agentId = explicitAgentId ?? sessionAgentId;
    if (!agentId || !params.agentFilter.includes(agentId)) {
      return false;
    }
  }

  if (params.sessionFilter?.length) {
    const sessionKey = normalizeOptionalString(params.request.sessionKey);
    if (!sessionKey || !matchesApprovalRequestSessionFilter(sessionKey, params.sessionFilter)) {
      return false;
    }
  }

  return true;
}
