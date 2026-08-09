// Msteams plugin module implements secret contract behavior.
import { createSimpleChannelSecretContract } from "openclaw/plugin-sdk/channel-secret-basic-runtime";

export const channelSecrets = createSimpleChannelSecretContract({
  channelKey: "msteams",
  label: "Microsoft Teams",
  accountFields: [],
  channelFields: ["appPassword"],
  mode: "channel-only",
});

export const { secretTargetRegistryEntries, collectRuntimeConfigAssignments } = channelSecrets;
