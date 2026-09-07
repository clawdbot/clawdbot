import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveSlackAccount, resolveSlackOperationToken } from "./accounts.js";
import { createSlackLookupClient } from "./client.js";
import { collectSlackCursorPages } from "./cursor-pages.js";
import { getSlackInstallationKind } from "./installation-identity-state.js";

/** Resolve a workspace for a detached Enterprise DM without opening a conversation. */
export async function resolveSlackEnterpriseUserTeamId(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  userId: string;
}): Promise<string | undefined> {
  const account = resolveSlackAccount(params);
  if (getSlackInstallationKind(account.accountId) !== "enterprise") {
    return undefined;
  }

  // Discover with the sending credential. A separate read-only user token can
  // see workspaces where the bot itself is not installed.
  const token = resolveSlackOperationToken(account, "write");
  if (!token) {
    throw new Error("unsupported_enterprise_slack_delivery: missing Slack sending token");
  }
  const client = createSlackLookupClient(token);
  const response = await client.users.info({ user: params.userId });
  const user = response.user;
  if (
    !response.ok ||
    !user ||
    user.deleted ||
    (user.id !== params.userId && user.enterprise_user?.id !== params.userId)
  ) {
    throw new Error("unsupported_enterprise_slack_delivery: could not verify Slack recipient");
  }
  const memberTeamIds = new Set(user.enterprise_user?.teams ?? []);
  const installedTeamIds = await collectSlackCursorPages({
    fetchPage: (cursor) => client.auth.teams.list({ limit: 1000, cursor }),
    collectPageItems: (page) => {
      if (!page.ok) {
        throw new Error("unsupported_enterprise_slack_delivery: could not verify Slack workspaces");
      }
      return (page.teams ?? []).flatMap((team) =>
        team.id && /^T[A-Z0-9]+$/.test(team.id) ? [team.id] : [],
      );
    },
  });
  // One user gets one DM, even when the app and user share several workspaces.
  // Stable ordering keeps the chosen route independent of Slack page ordering.
  const teamId = installedTeamIds.filter((id) => memberTeamIds.has(id)).toSorted()[0];
  if (!teamId) {
    throw new Error(
      "unsupported_enterprise_slack_delivery: recipient shares no verified installed workspace",
    );
  }
  return teamId;
}
