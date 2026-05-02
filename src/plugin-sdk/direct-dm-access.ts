import type { ChannelId } from "../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  readStoreAllowFromForDmPolicy,
  resolveDmGroupAccessWithLists,
  type DmGroupAccessReasonCode,
} from "../security/dm-policy-shared.js";
import {
  expandAllowFromWithAccessGroups,
  type AccessGroupMembershipResolver,
} from "./access-groups.js";
export type { AccessGroupMembershipResolver } from "./access-groups.js";

export type DirectDmCommandAuthorizationRuntime = {
  shouldComputeCommandAuthorized: (rawBody: string, cfg: OpenClawConfig) => boolean;
  resolveCommandAuthorizedFromAuthorizers: (params: {
    useAccessGroups: boolean;
    authorizers: Array<{ configured: boolean; allowed: boolean }>;
    modeWhenAccessGroupsOff?: "allow" | "deny" | "configured";
  }) => boolean;
};

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

/** Resolve direct-DM policy, effective allowlists, and optional command auth in one place. */
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

  const shouldComputeAuth = params.runtime.shouldComputeCommandAuthorized(
    params.rawBody,
    params.cfg,
  );
  const senderAllowedForCommands = params.isSenderAllowed(
    params.senderId,
    access.effectiveAllowFrom,
  );
  const commandAuthorized = shouldComputeAuth
    ? params.runtime.resolveCommandAuthorizedFromAuthorizers({
        useAccessGroups: params.cfg.commands?.useAccessGroups !== false,
        authorizers: [
          {
            configured: access.effectiveAllowFrom.length > 0,
            allowed: senderAllowedForCommands,
          },
        ],
        modeWhenAccessGroupsOff: params.modeWhenAccessGroupsOff,
      })
    : undefined;

  return {
    access: {
      decision: access.decision,
      reasonCode: access.reasonCode,
      reason: access.reason,
      effectiveAllowFrom: access.effectiveAllowFrom,
    },
    shouldComputeAuth,
    senderAllowedForCommands,
    commandAuthorized,
  };
}

/** Convert resolved DM policy into a pre-crypto allow/block/pairing callback. */
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
