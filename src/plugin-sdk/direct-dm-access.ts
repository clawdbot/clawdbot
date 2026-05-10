import type { ChannelId } from "../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  expandAllowFromWithAccessGroups,
  type AccessGroupMembershipResolver,
} from "./access-groups.js";
import { DM_GROUP_ACCESS_REASON, type DmGroupAccessReasonCode } from "./channel-access-compat.js";
import {
  readStoreAllowFromForDmPolicy,
  resolveDmGroupAccessWithLists,
} from "./channel-access-compat.js";
export type { AccessGroupMembershipResolver } from "./access-groups.js";

export type DirectDmCommandAuthorizationRuntime = {
  shouldComputeCommandAuthorized: (rawBody: string, cfg: OpenClawConfig) => boolean;
  /** @deprecated Command authorization is resolved by channel ingress. Kept for runtime injection compatibility. */
  resolveCommandAuthorizedFromAuthorizers?: (params: {
    useAccessGroups: boolean;
    authorizers: Array<{ configured: boolean; allowed: boolean }>;
    modeWhenAccessGroupsOff?: "allow" | "deny" | "configured";
  }) => boolean;
};

/** @deprecated Use `resolveChannelMessageIngress` from `openclaw/plugin-sdk/channel-ingress-runtime`. */
export type ResolvedInboundDirectDmAccess = {
  access: {
    decision: "allow" | "block" | "pairing";
    reasonCode: DmGroupAccessReasonCode;
    reason: string;
    effectiveAllowFrom: string[];
  };
  shouldComputeAuth: boolean;
  senderAllowedForCommands: boolean;
  commandAuthorized: boolean | undefined;
};

function toLegacyDmReasonCode(reasonCode: string): DmGroupAccessReasonCode {
  switch (reasonCode) {
    case DM_GROUP_ACCESS_REASON.DM_POLICY_OPEN:
    case DM_GROUP_ACCESS_REASON.DM_POLICY_DISABLED:
    case DM_GROUP_ACCESS_REASON.DM_POLICY_ALLOWLISTED:
    case DM_GROUP_ACCESS_REASON.DM_POLICY_PAIRING_REQUIRED:
    case DM_GROUP_ACCESS_REASON.DM_POLICY_NOT_ALLOWLISTED:
      return reasonCode;
    default:
      return DM_GROUP_ACCESS_REASON.DM_POLICY_NOT_ALLOWLISTED;
  }
}

/** @deprecated Use `resolveChannelMessageIngress` from `openclaw/plugin-sdk/channel-ingress-runtime`. */
export async function resolveInboundDirectDmAccessWithRuntime(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  accountId: string;
  dmPolicy?: string | null;
  allowFrom?: Array<string | number> | null;
  senderId: string;
  rawBody: string;
  isSenderAllowed: (senderId: string, allowFrom: string[]) => boolean;
  resolveAccessGroupMembership?: AccessGroupMembershipResolver;
  runtime: DirectDmCommandAuthorizationRuntime;
  modeWhenAccessGroupsOff?: "allow" | "deny" | "configured";
  readStoreAllowFrom?: (provider: ChannelId, accountId: string) => Promise<string[]>;
}): Promise<ResolvedInboundDirectDmAccess> {
  const dmPolicy = params.dmPolicy ?? "pairing";
  const shouldComputeAuth = params.runtime.shouldComputeCommandAuthorized(
    params.rawBody,
    params.cfg,
  );
  const storeAllowFrom =
    dmPolicy === "pairing"
      ? await readStoreAllowFromForDmPolicy({
          provider: params.channel,
          accountId: params.accountId,
          dmPolicy,
          readStore: params.readStoreAllowFrom,
        })
      : [];
  const [allowFrom, effectiveStoreAllowFrom] = await Promise.all([
    expandAllowFromWithAccessGroups({
      cfg: params.cfg,
      allowFrom: params.allowFrom,
      channel: params.channel,
      accountId: params.accountId,
      senderId: params.senderId,
      isSenderAllowed: params.isSenderAllowed,
      resolveMembership: params.resolveAccessGroupMembership,
    }),
    expandAllowFromWithAccessGroups({
      cfg: params.cfg,
      allowFrom: storeAllowFrom,
      channel: params.channel,
      accountId: params.accountId,
      senderId: params.senderId,
      isSenderAllowed: params.isSenderAllowed,
      resolveMembership: params.resolveAccessGroupMembership,
    }),
  ]);
  const access = resolveDmGroupAccessWithLists({
    isGroup: false,
    dmPolicy,
    allowFrom,
    storeAllowFrom: effectiveStoreAllowFrom,
    groupAllowFromFallbackToAllowFrom: false,
    isSenderAllowed: (allowEntries) => params.isSenderAllowed(params.senderId, allowEntries),
  });
  const reasonCode = toLegacyDmReasonCode(access.reasonCode);
  const senderAllowedForCommands = params.isSenderAllowed(
    params.senderId,
    access.effectiveAllowFrom,
  );
  const commandAuthorized = shouldComputeAuth
    ? (params.runtime.resolveCommandAuthorizedFromAuthorizers?.({
        useAccessGroups: params.cfg.commands?.useAccessGroups !== false,
        authorizers: [
          {
            configured: access.effectiveAllowFrom.length > 0,
            allowed: senderAllowedForCommands,
          },
        ],
        modeWhenAccessGroupsOff: params.modeWhenAccessGroupsOff,
      }) ?? senderAllowedForCommands)
    : undefined;

  return {
    access: {
      decision: access.decision,
      reasonCode,
      reason: access.reason,
      effectiveAllowFrom: access.effectiveAllowFrom,
    },
    shouldComputeAuth,
    senderAllowedForCommands,
    commandAuthorized,
  };
}

/** @deprecated Use `resolveChannelMessageIngress` from `openclaw/plugin-sdk/channel-ingress-runtime`. */
export function createPreCryptoDirectDmAuthorizer(params: {
  resolveAccess: (
    senderId: string,
  ) => Promise<Pick<ResolvedInboundDirectDmAccess, "access"> | ResolvedInboundDirectDmAccess>;
  issuePairingChallenge?: (params: {
    senderId: string;
    reply: (text: string) => Promise<void>;
  }) => Promise<void>;
  onBlocked?: (params: {
    senderId: string;
    reason: string;
    reasonCode: DmGroupAccessReasonCode;
  }) => void;
}) {
  return async (input: {
    senderId: string;
    reply: (text: string) => Promise<void>;
  }): Promise<"allow" | "block" | "pairing"> => {
    const resolved = await params.resolveAccess(input.senderId);
    const access = "access" in resolved ? resolved.access : resolved;
    if (access.decision === "allow") {
      return "allow";
    }
    if (access.decision === "pairing") {
      if (params.issuePairingChallenge) {
        await params.issuePairingChallenge({
          senderId: input.senderId,
          reply: input.reply,
        });
      }
      return "pairing";
    }
    params.onBlocked?.({
      senderId: input.senderId,
      reason: access.reason,
      reasonCode: access.reasonCode,
    });
    return "block";
  };
}
