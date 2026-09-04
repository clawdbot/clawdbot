// Slack plugin module owns authenticated installation identity state.
import { normalizeAccountId } from "openclaw/plugin-sdk/account-resolution";
import { resolveGlobalMap } from "openclaw/plugin-sdk/global-singleton";

type SlackInstallationKind = "workspace" | "enterprise" | "degraded";

type SlackInstallationStateEntry = {
  kind: SlackInstallationKind;
  owner: symbol;
};

type SlackInstallationStateRegistration = {
  update: (kind: SlackInstallationKind) => void;
  release: () => void;
};

const slackInstallationStates = resolveGlobalMap<string, SlackInstallationStateEntry>(
  Symbol.for("openclaw.slack.installation-identities"),
  "close-and-restart",
);

export function registerSlackInstallationState(
  accountId: string,
  kind: SlackInstallationKind,
): SlackInstallationStateRegistration {
  const normalizedAccountId = normalizeAccountId(accountId);
  const owner = Symbol(`slack-installation:${normalizedAccountId}`);
  slackInstallationStates.set(normalizedAccountId, { kind, owner });
  return {
    update: (nextKind) => {
      if (slackInstallationStates.get(normalizedAccountId)?.owner === owner) {
        slackInstallationStates.set(normalizedAccountId, { kind: nextKind, owner });
      }
    },
    release: () => {
      if (slackInstallationStates.get(normalizedAccountId)?.owner === owner) {
        slackInstallationStates.delete(normalizedAccountId);
      }
    },
  };
}

export function getSlackInstallationKind(accountId: string): SlackInstallationKind | undefined {
  return slackInstallationStates.get(normalizeAccountId(accountId))?.kind;
}

export function isSlackWorkspaceInstallation(accountId: string): boolean {
  return getSlackInstallationKind(accountId) === "workspace";
}
