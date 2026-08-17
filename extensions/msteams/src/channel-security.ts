import { createConditionalWarningCollector } from "openclaw/plugin-sdk/channel-policy";
import { collectMSTeamsSecurityWarnings } from "./channel-config.js";

export function createMSTeamsSecurityWarningCollector(
  findingsFactory: typeof createConditionalWarningCollector.findings | undefined,
) {
  // Official beta hosts expose the legacy string collector without `.findings`.
  // Preserve their audit path while current hosts receive structured critical findings.
  return typeof findingsFactory === "function"
    ? findingsFactory({
        collectWarnings: collectMSTeamsSecurityWarnings,
        checkId: "channels.msteams.groups.open",
        severity: "critical",
        title: "MS Teams security warning",
      })
    : collectMSTeamsSecurityWarnings;
}
