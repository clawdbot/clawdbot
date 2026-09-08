// The Slack monitor owns process-local installation identity. Missing state means the monitor
// never ran, not that the account is Enterprise Grid, so standalone CLI sends retain bare targets.
import { getSlackInstallationKind } from "./installation-identity-state.js";

export function assertSlackDetachedTargetAllowed(accountId: string, teamId?: string): void {
  const installationKind = getSlackInstallationKind(accountId);
  if (installationKind && installationKind !== "workspace" && !teamId) {
    throw new Error(
      "unsupported_enterprise_slack_delivery: detached Slack operations require team:<team-id>:channel:<channel-id> or team:<team-id>:user:<user-id> until a workspace install is authenticated",
    );
  }
}
