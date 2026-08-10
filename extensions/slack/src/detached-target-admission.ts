// Slack plugin module owns admission for detached operations after installation identity is known.
import { getSlackInstallationKind } from "./installation-identity-state.js";

export function assertSlackDetachedTargetAllowed(accountId: string, teamId?: string): void {
  if (getSlackInstallationKind(accountId) === "enterprise" && !teamId) {
    throw new Error(
      "unsupported_enterprise_slack_delivery: detached Enterprise Grid operations require team:<team-id>:channel:<channel-id> or team:<team-id>:user:<user-id>",
    );
  }
}
