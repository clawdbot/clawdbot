// Slack plugin module owns admission for exported/direct delivery paths.
import type { ResolvedSlackAccount } from "./accounts.js";

export function assertSlackDirectSendAllowed(account: ResolvedSlackAccount): void {
  if (account.config.enterpriseOrgInstall === true) {
    throw new Error("unsupported_enterprise_slack_delivery");
  }
}
