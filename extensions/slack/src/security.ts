import { createScopedDmSecurityResolver } from "openclaw/plugin-sdk/channel-config-helpers";
import { createOpenProviderConfiguredRouteWarningCollector } from "openclaw/plugin-sdk/channel-policy";
import type { ResolvedSlackAccount } from "./accounts.js";
import type { ChannelPlugin } from "./channel-api.js";
import { collectSlackSecurityAuditFindings } from "./security-audit.js";

const resolveSlackDmPolicy = createScopedDmSecurityResolver<ResolvedSlackAccount>({
  channelKey: "slack",
  resolvePolicy: (account) => account.dm?.policy,
  resolveAllowFrom: (account) => account.dm?.allowFrom,
  allowFromPathSuffix: "dm.",
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

export const slackSecurityAdapter = {
  resolveDmPolicy: resolveSlackDmPolicy,
  collectWarnings: collectSlackSecurityWarnings,
  collectAuditFindings: collectSlackSecurityAuditFindings,
} satisfies NonNullable<ChannelPlugin<ResolvedSlackAccount>["security"]>;
