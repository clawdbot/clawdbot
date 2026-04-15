import {
  createPatchedAccountSetupAdapter,
  createSetupInputPresenceValidator,
} from "openclaw/plugin-sdk/setup-runtime";

const channel = "googlechat" as const;

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
    const patch = input.useEnv
      ? {}
      : input.tokenFile
        ? { serviceAccountFile: input.tokenFile }
        : input.token
          ? { serviceAccount: input.token }
          : {};
    const audienceType = input.audienceType?.trim();
    const audience = input.audience?.trim();
    const webhookPath = input.webhookPath?.trim();
    const webhookUrl = input.webhookUrl?.trim();
    return {
      ...patch,
      ...(audienceType ? { audienceType } : {}),
      ...(audience ? { audience } : {}),
      ...(webhookPath ? { webhookPath } : {}),
      ...(webhookUrl ? { webhookUrl } : {}),
    };
  },
});
