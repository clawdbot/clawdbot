import type { DiscordAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import { isDangerousNameMatchingEnabled } from "openclaw/plugin-sdk/dangerous-name-runtime";
import { allowListMatches, normalizeDiscordAllowList } from "../monitor/allow-list.js";

const ACTIVITY_ALLOWLIST_PREFIXES = ["discord:", "user:", "pk:"];

type DiscordActivityUser = {
  id: string;
  username?: string;
  discriminator?: string;
};

export function resolveActivityUserAuthorized(
  account: DiscordAccountConfig,
  user: DiscordActivityUser,
): boolean {
  const entries = [...(account.allowFrom ?? []), ...(account.dm?.allowFrom ?? [])];
  const allowList = normalizeDiscordAllowList(entries, ACTIVITY_ALLOWLIST_PREFIXES);
  if (!allowList) {
    return (account.dmPolicy ?? account.dm?.policy) === "open";
  }
  const discriminator = user.discriminator?.trim();
  const tag =
    user.username && discriminator && discriminator !== "0"
      ? `${user.username}#${discriminator}`
      : user.username;
  return allowListMatches(
    allowList,
    { id: user.id, name: user.username, tag },
    { allowNameMatching: isDangerousNameMatchingEnabled(account) },
  );
}
