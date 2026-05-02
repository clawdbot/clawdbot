import { expandAllowFromWithAccessGroups } from "openclaw/plugin-sdk/command-auth";
import { resolveCommandAuthorizedFromAuthorizers } from "openclaw/plugin-sdk/command-auth-native";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import {
  readStoreAllowFromForDmPolicy,
  resolveDmGroupAccessWithLists,
  type DmGroupAccessDecision,
} from "openclaw/plugin-sdk/security-runtime";
import type { RequestClient } from "../internal/discord.js";
import { createDiscordAccessGroupMembershipResolver } from "./access-groups.js";
import { normalizeDiscordAllowList, resolveDiscordAllowListMatch } from "./allow-list.js";

const DISCORD_ALLOW_LIST_PREFIXES = ["discord:", "user:", "pk:"];

export type DiscordDmPolicy = "open" | "pairing" | "allowlist" | "disabled";

export type DiscordDmCommandAccess = {
  decision: DmGroupAccessDecision;
  reason: string;
  commandAuthorized: boolean;
  allowMatch: ReturnType<typeof resolveDiscordAllowListMatch> | { allowed: false };
};

function resolveSenderAllowMatch(params: {
  allowEntries: string[];
  sender: { id: string; name?: string; tag?: string };
  allowNameMatching: boolean;
}) {
  const allowList = normalizeDiscordAllowList(params.allowEntries, DISCORD_ALLOW_LIST_PREFIXES);
  return allowList
    ? resolveDiscordAllowListMatch({
        allowList,
        candidate: params.sender,
        allowNameMatching: params.allowNameMatching,
      })
    : ({ allowed: false } as const);
}

function resolveDmPolicyCommandAuthorization(params: {
  decision: DmGroupAccessDecision;
  commandAuthorized: boolean;
}) {
  return params.commandAuthorized;
}

async function expandAllowFromWithDiscordAccessGroups(params: {
  cfg?: OpenClawConfig;
  allowFrom: string[];
  sender: { id: string };
  accountId: string;
  token?: string;
  rest?: RequestClient;
}) {
  return await expandAllowFromWithAccessGroups({
    cfg: params.cfg,
    allowFrom: params.allowFrom,
    channel: "discord",
    accountId: params.accountId,
    senderId: params.sender.id,
    senderAllowEntry: `discord:${params.sender.id}`,
    isSenderAllowed: (senderId, allowFrom) =>
      resolveSenderAllowMatch({
        allowEntries: allowFrom,
        sender: { id: senderId },
        allowNameMatching: false,
      }).allowed,
    resolveMembership: createDiscordAccessGroupMembershipResolver({
      token: params.token,
      rest: params.rest,
    }),
  });
}

export async function resolveDiscordDmCommandAccess(params: {
  accountId: string;
  dmPolicy: DiscordDmPolicy;
  configuredAllowFrom: string[];
  sender: { id: string; name?: string; tag?: string };
  allowNameMatching: boolean;
  useAccessGroups: boolean;
  cfg?: OpenClawConfig;
  token?: string;
  rest?: RequestClient;
  readStoreAllowFrom?: () => Promise<string[]>;
}): Promise<DiscordDmCommandAccess> {
  const storeAllowFrom = params.readStoreAllowFrom
    ? params.dmPolicy === "open"
      ? []
      : await params.readStoreAllowFrom().catch(() => [])
    : await readStoreAllowFromForDmPolicy({
        provider: "discord",
        accountId: params.accountId,
        dmPolicy: params.dmPolicy,
        shouldRead: params.dmPolicy !== "open",
      });
  const [configuredAllowFrom, effectiveStoreAllowFrom] = await Promise.all([
    expandAllowFromWithDiscordAccessGroups({
      cfg: params.cfg,
      allowFrom: params.configuredAllowFrom,
      sender: params.sender,
      accountId: params.accountId,
      token: params.token,
      rest: params.rest,
    }),
    expandAllowFromWithDiscordAccessGroups({
      cfg: params.cfg,
      allowFrom: storeAllowFrom,
      sender: params.sender,
      accountId: params.accountId,
      token: params.token,
      rest: params.rest,
    }),
  ]);

  const access = resolveDmGroupAccessWithLists({
    isGroup: false,
    dmPolicy: params.dmPolicy,
    allowFrom: configuredAllowFrom,
    groupAllowFrom: [],
    storeAllowFrom: effectiveStoreAllowFrom,
    isSenderAllowed: (allowEntries) =>
      resolveSenderAllowMatch({
        allowEntries,
        sender: params.sender,
        allowNameMatching: params.allowNameMatching,
      }).allowed,
  });

  const allowMatch = resolveSenderAllowMatch({
    allowEntries: access.effectiveAllowFrom,
    sender: params.sender,
    allowNameMatching: params.allowNameMatching,
  });

  const commandAuthorized = resolveCommandAuthorizedFromAuthorizers({
    useAccessGroups: params.useAccessGroups,
    authorizers: [
      {
        configured: access.effectiveAllowFrom.length > 0,
        allowed: allowMatch.allowed,
      },
    ],
    modeWhenAccessGroupsOff: "configured",
  });

  return {
    decision: access.decision,
    reason: access.reason,
    commandAuthorized:
      access.decision === "allow"
        ? resolveDmPolicyCommandAuthorization({
            decision: access.decision,
            commandAuthorized,
          })
        : false,
    allowMatch,
  };
}
