import { createScopedDmSecurityResolver } from "openclaw/plugin-sdk/channel-config-helpers";
import { createOpenProviderConfiguredRouteWarningCollector } from "openclaw/plugin-sdk/channel-policy";
import {
  resolveDiscordAccountAllowFrom,
  resolveDiscordAccountDmPolicy,
  type ResolvedDiscordAccount,
} from "./accounts.js";
import type { ChannelPlugin } from "./channel-api.js";

const resolveDiscordDmPolicy = createScopedDmSecurityResolver<ResolvedDiscordAccount>({
  channelKey: "discord",
  resolvePolicy: (account) => account.config.dmPolicy,
  resolveAllowFrom: (account) => account.config.allowFrom,
  resolveAccess: ({ cfg, account }) => ({
    dmPolicy: resolveDiscordAccountDmPolicy({ cfg, accountId: account.accountId }),
    allowFrom: resolveDiscordAccountAllowFrom({ cfg, accountId: account.accountId }),
  }),
  policyPathSuffix: "dmPolicy",
  normalizeEntry: (raw) =>
    raw
      .trim()
      .replace(/^(discord|user):/i, "")
      .replace(/^<@!?(\d+)>$/, "$1"),
});

const collectDiscordSecurityWarnings =
  createOpenProviderConfiguredRouteWarningCollector<ResolvedDiscordAccount>({
    providerConfigPresent: (cfg) => cfg.channels?.discord !== undefined,
    resolveGroupPolicy: (account) => account.config.groupPolicy,
    resolveRouteAllowlistConfigured: (account) =>
      Object.keys(account.config.guilds ?? {}).length > 0,
    configureRouteAllowlist: {
      surface: "Discord guilds",
      openScope: "any channel not explicitly denied",
      groupPolicyPath: "channels.discord.groupPolicy",
      routeAllowlistPath: "channels.discord.guilds.<id>.channels",
    },
    missingRouteAllowlist: {
      surface: "Discord guilds",
      openBehavior: "with no guild/channel allowlist; any channel can trigger (mention-gated)",
      remediation:
        'Set channels.discord.groupPolicy="allowlist" and configure channels.discord.guilds.<id>.channels',
    },
  });

let discordSecurityAuditModulePromise:
  | Promise<typeof import("./security-audit.runtime.js")>
  | undefined;

async function loadDiscordSecurityAuditModule() {
  discordSecurityAuditModulePromise ??= import("./security-audit.runtime.js");
  return await discordSecurityAuditModulePromise;
}

export const discordSecurityAdapter = {
  resolveDmPolicy: resolveDiscordDmPolicy,
  collectWarnings: collectDiscordSecurityWarnings,
  collectAuditFindings: async (params) =>
    (await loadDiscordSecurityAuditModule()).collectDiscordSecurityAuditFindings(params),
} satisfies NonNullable<ChannelPlugin<ResolvedDiscordAccount>["security"]>;
