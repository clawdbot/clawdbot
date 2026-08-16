import { defineChannelSetupContract } from "openclaw/plugin-sdk/channel-setup";
// Googlechat plugin module implements setup core behavior.
import type { ChannelSetupInput } from "openclaw/plugin-sdk/channel-setup";
import {
  createPatchedAccountSetupAdapter,
  createSetupInputPresenceValidator,
  type ChannelSetupAdapter,
} from "openclaw/plugin-sdk/setup-runtime";

const channel = "googlechat" as const;

type GoogleChatSetupInput = ChannelSetupInput & {
  audienceType?: string;
  audience?: string;
  webhookPath?: string;
  webhookUrl?: string;
};

const googlechatSetupAdapterBase = createPatchedAccountSetupAdapter<GoogleChatSetupInput>({
  channelKey: channel,
  validateInput: createSetupInputPresenceValidator({
    defaultAccountOnlyEnvError:
      "GOOGLE_CHAT_SERVICE_ACCOUNT env vars can only be used for the default account.",
    whenNotUseEnv: [
      {
        someOf: ["token", "tokenFile"],
        message: "Google Chat requires --token (service account JSON) or --token-file.",
      },
    ],
  }),
  buildPatch: (input) => {
    const setupInput = input as GoogleChatSetupInput;
    const patch = setupInput.useEnv
      ? {}
      : setupInput.tokenFile
        ? { serviceAccountFile: setupInput.tokenFile }
        : setupInput.token
          ? { serviceAccount: setupInput.token }
          : {};
    const audienceType = setupInput.audienceType?.trim();
    const audience = setupInput.audience?.trim();
    const webhookPath = setupInput.webhookPath?.trim();
    const webhookUrl = setupInput.webhookUrl?.trim();
    return {
      ...patch,
      ...(audienceType ? { audienceType } : {}),
      ...(audience ? { audience } : {}),
      ...(webhookPath ? { webhookPath } : {}),
      ...(webhookUrl ? { webhookUrl } : {}),
    };
  },
});

export const googlechatSetupAdapter: ChannelSetupAdapter = {
  ...googlechatSetupAdapterBase,
  singleAccountKeysToMove: [
    "serviceAccount",
    "serviceAccountFile",
    "audienceType",
    "audience",
    "webhookPath",
    "webhookUrl",
  ],
  // mergeGoogleChatAccountConfig deliberately strips serviceAccount and
  // serviceAccountFile when merging accounts.default into a named account:
  // credentials are not part of the shared default-account surface. Promoting
  // them while named accounts exist would strand named accounts that currently
  // inherit the root credential, so named-account promotion is limited to the
  // fields the resolver does share (webhook/audience and access policy).
  namedAccountPromotionKeys: [
    "audienceType",
    "audience",
    "webhookPath",
    "webhookUrl",
    "dmPolicy",
    "allowFrom",
    "groupPolicy",
    "groupAllowFrom",
  ],
};

export const googlechatSetupContract = defineChannelSetupContract({
  fields: {
    token: {
      kind: "string",
      sensitive: true,
      cli: { flags: "--token <json>", description: "Google Chat service account JSON" },
    },
    tokenFile: {
      kind: "string",
      sensitive: true,
      cli: { flags: "--token-file <path>", description: "Google Chat service account file" },
    },
    audienceType: {
      kind: "choice",
      choices: ["app-url", "project-number"],
      cli: { flags: "--audience-type <type>", description: "Google Chat audience type" },
    },
    audience: {
      kind: "string",
      cli: { flags: "--audience <value>", description: "Google Chat audience value" },
    },
    webhookPath: {
      kind: "string",
      cli: { flags: "--webhook-path <path>", description: "Google Chat webhook path" },
    },
    webhookUrl: {
      kind: "string",
      cli: { flags: "--webhook-url <url>", description: "Google Chat webhook URL" },
    },
    useEnv: {
      kind: "boolean",
      cli: { flags: "--use-env", description: "Use Google Chat environment credentials" },
      envVars: ["GOOGLE_CHAT_SERVICE_ACCOUNT", "GOOGLE_CHAT_SERVICE_ACCOUNT_FILE"],
      envVarMode: "any",
    },
  },
  legacyAdapter: googlechatSetupAdapter,
});
