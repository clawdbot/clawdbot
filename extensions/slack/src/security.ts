import { createScopedDmSecurityResolver } from "openclaw/plugin-sdk/channel-config-helpers";
import { createOpenProviderConfiguredRouteWarningCollector } from "openclaw/plugin-sdk/channel-policy";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import {
  resolveSlackAccountAllowFrom,
  resolveSlackAccountDmPolicy,
  type ResolvedSlackAccount,
} from "./accounts.js";
import type { ChannelPlugin } from "./channel-api.js";

const resolveSlackDmPolicy = createScopedDmSecurityResolver<ResolvedSlackAccount>({
  channelKey: "slack",
  resolvePolicy: (account) => account.config.dmPolicy,
  resolveAllowFrom: (account) => account.config.allowFrom,
  resolveAccess: ({ cfg, account }) => ({
    dmPolicy: resolveSlackAccountDmPolicy({ cfg, accountId: account.accountId }),
    allowFrom: resolveSlackAccountAllowFrom({ cfg, accountId: account.accountId }),
  }),
  policyPathSuffix: "dmPolicy",
  normalizeEntry: (raw) =>
    raw
      .trim()
      .replace(/^(slack|user):/i, "")
      .trim(),
});

const collectSlackSecurityWarnings =
  createOpenProviderConfiguredRouteWarningCollector<ResolvedSlackAccount>({
    providerConfigPresent: (cfg) => cfg.channels?.slack !== undefined,
    resolveGroupPolicy: (account) => account.config.groupPolicy,
    resolveRouteAllowlistConfigured: (account) =>
      Boolean(account.config.channels) && Object.keys(account.config.channels ?? {}).length > 0,
    configureRouteAllowlist: {
      surface: "Slack channels",
      openScope: "any channel not explicitly denied",
      groupPolicyPath: "channels.slack.groupPolicy",
      routeAllowlistPath: "channels.slack.channels",
    },
    missingRouteAllowlist: {
      surface: "Slack channels",
      openBehavior: "with no channel allowlist; any channel can trigger (mention-gated)",
      remediation:
        'Set channels.slack.groupPolicy="allowlist" and configure channels.slack.channels',
    },
  });

const loadSlackSecurityAuditModule = createLazyRuntimeModule(() => import("./security-audit.js"));

export const slackSecurityAdapter = {
  resolveDmPolicy: resolveSlackDmPolicy,
  collectWarnings: collectSlackSecurityWarnings,
  collectAuditFindings: async (params) => {
    const { collectSlackSecurityAuditFindings } = await loadSlackSecurityAuditModule();
    return await collectSlackSecurityAuditFindings(params);
  },
} satisfies NonNullable<ChannelPlugin<ResolvedSlackAccount>["security"]>;
