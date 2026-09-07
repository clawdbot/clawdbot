import {
  createAllowlistProviderGroupPolicyWarningCollector,
  createConditionalWarningCollector,
} from "openclaw/plugin-sdk/channel-policy";
// Msteams plugin module owns lightweight channel security warnings shared by setup and runtime.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

const collectMSTeamsSecurityWarnings = createAllowlistProviderGroupPolicyWarningCollector<{
  cfg: OpenClawConfig;
}>({
  providerConfigPresent: (cfg) => cfg.channels?.msteams !== undefined,
  resolveGroupPolicy: ({ cfg }) => cfg.channels?.msteams?.groupPolicy,
  collect: ({ groupPolicy }) =>
    groupPolicy === "open"
      ? [
          '- MS Teams groups: groupPolicy="open" allows any member to trigger (mention-gated). Set channels.msteams.groupPolicy="allowlist" + channels.msteams.groupAllowFrom to restrict senders.',
        ]
      : [],
});

export const collectMSTeamsSecurityFindings = createConditionalWarningCollector.findings({
  collectWarnings: collectMSTeamsSecurityWarnings,
  checkId: "channels.msteams.groups.open",
  severity: "critical",
  title: "MS Teams security warning",
});
