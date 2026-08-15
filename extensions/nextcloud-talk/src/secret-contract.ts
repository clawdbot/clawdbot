// Nextcloud Talk plugin module implements secret contract behavior.
import { createSimpleChannelSecretContract } from "openclaw/plugin-sdk/channel-secret-basic-runtime";

export const channelSecrets = createSimpleChannelSecretContract({
  channelKey: "nextcloud-talk",
  label: "Nextcloud Talk",
  accountFields: ["apiPassword", "botSecret"],
  channelFields: ["apiPassword", "botSecret"],
  mode: {
    kind: "surface-inheritance",
    // Runtime collection historically reports botSecret before apiPassword.
    collectionFields: ["botSecret", "apiPassword"],
  },
});

export const { secretTargetRegistryEntries, collectRuntimeConfigAssignments } = channelSecrets;
