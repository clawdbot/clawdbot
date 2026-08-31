import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  buildAgentSessionKey,
  normalizeAccountId,
  type ResolvedAgentRoute,
} from "openclaw/plugin-sdk/routing";

export function resolveTelegramDirectPeerId(params: {
  chatId: number | string;
  senderId?: number | string | null;
}) {
  const normalized = params.senderId == null ? "" : String(params.senderId).trim();
  return normalized || String(params.chatId);
}

export function resolveTelegramNamedAccountBaseSessionKey(
  defaultAccountId: string,
  params: {
    cfg: OpenClawConfig;
    route: Pick<ResolvedAgentRoute, "agentId" | "accountId" | "matchedBy" | "sessionKey">;
    chatId: number | string;
    isGroup: boolean;
    senderId?: string | number | null;
  },
): string {
  const routeAccountId = normalizeAccountId(params.route.accountId);
  const normalizedDefaultAccountId = normalizeAccountId(defaultAccountId);
  const isNamedAccountFallback =
    routeAccountId !== normalizedDefaultAccountId && params.route.matchedBy === "default";
  if (!isNamedAccountFallback || params.isGroup) {
    return params.route.sessionKey;
  }
  return buildAgentSessionKey({
    agentId: params.route.agentId,
    channel: "telegram",
    accountId: params.route.accountId,
    peer: {
      kind: "direct",
      id: resolveTelegramDirectPeerId({
        chatId: params.chatId,
        senderId: params.senderId,
      }),
    },
    dmScope: "per-account-channel-peer",
    identityLinks: params.cfg.session?.identityLinks,
  });
}

export function resolveTelegramSecurityDmRoute(
  defaultAccountId: string,
  params: {
    cfg: OpenClawConfig;
    accountId: string;
    route: ResolvedAgentRoute;
    principalId?: string;
  },
): { kind: "core" | "isolated" } | { sessionKey: string } {
  if (params.principalId !== undefined) {
    return {
      sessionKey: resolveTelegramNamedAccountBaseSessionKey(defaultAccountId, {
        ...params,
        chatId: params.principalId,
        isGroup: false,
        senderId: params.principalId,
      }),
    };
  }
  const isNamedAccountFallback =
    normalizeAccountId(params.accountId) !== normalizeAccountId(defaultAccountId) &&
    params.route.matchedBy === "default";
  if (isNamedAccountFallback || params.route.dmScope === "per-account-channel-peer") {
    return { kind: "isolated" };
  }
  return params.route.dmScope === "main"
    ? { sessionKey: params.route.sessionKey }
    : { kind: "core" };
}
