// Mattermost plugin module implements secret contract behavior.
import { createSimpleChannelSecretContract } from "openclaw/plugin-sdk/channel-secret-basic-runtime";

export const channelSecrets = createSimpleChannelSecretContract({
  channelKey: "mattermost",
  label: "Mattermost",
  accountFields: ["botToken"],
  channelFields: ["botToken"],
  mode: "account-inheritance",
});

export const { secretTargetRegistryEntries, collectRuntimeConfigAssignments } = channelSecrets;
