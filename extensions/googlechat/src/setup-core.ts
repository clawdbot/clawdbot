import { defineChannelSetupContract } from "openclaw/plugin-sdk/channel-setup";
// Googlechat plugin module implements setup core behavior.
import type { ChannelSetupInput } from "openclaw/plugin-sdk/channel-setup";
import {
  createPatchedAccountSetupAdapter,
  createSetupInputPresenceValidator,
} from "openclaw/plugin-sdk/setup-runtime";

const channel = "googlechat" as const;

type GoogleChatSetupInput = ChannelSetupInput & {
  audienceType?: string;
  audience?: string;
  webhookPath?: string;
  webhookUrl?: string;
};

export const googlechatSetupAdapter = createPatchedAccountSetupAdapter({
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
    },
  },
  legacyAdapter: googlechatSetupAdapter,
});
