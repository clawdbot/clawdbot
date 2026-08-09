// Slack plugin module owns admission for exported/direct delivery paths.
import type { ResolvedSlackAccount } from "./accounts.js";

export function assertSlackDirectSendAllowed(account: ResolvedSlackAccount, teamId?: string): void {
  const hasTeamScope = Boolean(teamId?.trim());
  if (account.config.enterpriseOrgInstall === true && !hasTeamScope) {
    throw new Error("unsupported_enterprise_slack_delivery");
  }
  if (account.config.enterpriseOrgInstall !== true && hasTeamScope) {
    throw new Error("unexpected_enterprise_slack_workspace");
  }
}
