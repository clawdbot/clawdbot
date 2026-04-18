import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  resolveThreadSessionKeys,
  type ResolvedAgentRoute,
} from "openclaw/plugin-sdk/routing";

function resolveWhatsAppGroupAccountThreadId(accountId: string): string {
  return `whatsapp-account-${normalizeAccountId(accountId)}`;
}

export function resolveWhatsAppLegacyGroupSessionKey(params: {
  sessionKey: string;
  accountId?: string | null;
}): string | null {
  const accountId = normalizeAccountId(params.accountId);
  if (!accountId || accountId === DEFAULT_ACCOUNT_ID || !params.sessionKey.includes(":group:")) {
    return null;
  }
  const suffix = `:thread:${resolveWhatsAppGroupAccountThreadId(accountId)}`;
  return params.sessionKey.endsWith(suffix) ? params.sessionKey.slice(0, -suffix.length) : null;
}

export function resolveWhatsAppGroupSessionRoute(route: ResolvedAgentRoute): ResolvedAgentRoute {
  if (route.accountId === DEFAULT_ACCOUNT_ID || !route.sessionKey.includes(":group:")) {
    return route;
  }
  const scopedSession = resolveThreadSessionKeys({
    baseSessionKey: route.sessionKey,
    threadId: resolveWhatsAppGroupAccountThreadId(route.accountId),
  });
  return {
    ...route,
    sessionKey: scopedSession.sessionKey,
  };
}

export const __testing = {
  resolveWhatsAppGroupAccountThreadId,
  resolveWhatsAppLegacyGroupSessionKey,
};
