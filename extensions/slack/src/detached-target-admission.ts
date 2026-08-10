// Bare detached targets are safe only after auth.test positively identifies a workspace install.
import { getSlackInstallationKind } from "./installation-identity-state.js";

export function assertSlackDetachedTargetAllowed(accountId: string, teamId?: string): void {
  if (getSlackInstallationKind(accountId) !== "workspace" && !teamId) {
    throw new Error(
      "unsupported_enterprise_slack_delivery: detached Slack operations require team:<team-id>:channel:<channel-id> or team:<team-id>:user:<user-id> until a workspace install is authenticated",
    );
  }
}
