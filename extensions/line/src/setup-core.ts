import { defineChannelSetupContract } from "openclaw/plugin-sdk/channel-setup";
// Line plugin module implements setup core behavior.
import type {
  ChannelSetupAdapter,
  ChannelSetupInput,
  OpenClawConfig,
} from "openclaw/plugin-sdk/setup";
import {
  createSetupInputPresenceValidator,
  patchScopedAccountConfig,
} from "openclaw/plugin-sdk/setup";
import { hasLineCredentials, parseLineAllowFromId } from "./account-helpers.js";
import {
  DEFAULT_ACCOUNT_ID,
  listLineAccountIds,
  normalizeAccountId,
  resolveLineAccount,
} from "./setup-runtime-api.js";

type LineSetupInput = ChannelSetupInput & {
  channelAccessToken?: string;
  channelSecret?: string;
  secretFile?: string;
};

export function patchLineAccountConfig(params: {
  cfg: OpenClawConfig;
  accountId: string;
  patch: Record<string, unknown>;
  clearFields?: string[];
  enabled?: boolean;
}): OpenClawConfig {
  return patchScopedAccountConfig({
    cfg: params.cfg,
    channelKey: "line",
    accountId: params.accountId,
    patch: params.patch,
    accountPatch: {
      ...(params.enabled ? { enabled: true } : {}),
      ...params.patch,
    },
    ...(params.clearFields ? { clearFields: params.clearFields } : {}),
    ensureChannelEnabled: Boolean(params.enabled),
    ensureAccountEnabled: false,
  });
}

export function isLineConfigured(cfg: OpenClawConfig, accountId: string): boolean {
  return hasLineCredentials(resolveLineAccount({ cfg, accountId }));
}

export { parseLineAllowFromId };

export const lineSetupAdapter: ChannelSetupAdapter = {
  resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
  applyAccountName: ({ cfg, accountId, name }) =>
    patchLineAccountConfig({
      cfg,
      accountId,
      patch: name?.trim() ? { name: name.trim() } : {},
    }),
  validateInput: createSetupInputPresenceValidator({
    defaultAccountOnlyEnvError:
      "LINE_CHANNEL_ACCESS_TOKEN can only be used for the default account.",
    whenNotUseEnv: [
      {
        someOf: ["channelAccessToken", "token", "tokenFile"],
        message: "LINE requires channelAccessToken or --token-file (or --use-env).",
      },
      {
        someOf: ["channelSecret", "secretFile"],
        message: "LINE requires channelSecret or --secret-file (or --use-env).",
      },
    ],
  }),
  applyAccountConfig: ({ cfg, accountId, input }) => {
    const typedInput = input as LineSetupInput;
    // Shipped alias: `--token` writes channelAccessToken; the explicit switch wins.
    const accessToken = typedInput.channelAccessToken ?? typedInput.token;
    const normalizedAccountId = normalizeAccountId(accountId);
    if (normalizedAccountId === DEFAULT_ACCOUNT_ID) {
      return patchLineAccountConfig({
        cfg,
        accountId: normalizedAccountId,
        enabled: true,
        clearFields: typedInput.useEnv
          ? ["channelAccessToken", "channelSecret", "tokenFile", "secretFile"]
          : undefined,
        patch: typedInput.useEnv
          ? {}
          : {
              ...(typedInput.tokenFile
                ? { tokenFile: typedInput.tokenFile }
                : accessToken
                  ? { channelAccessToken: accessToken }
                  : {}),
              ...(typedInput.secretFile
                ? { secretFile: typedInput.secretFile }
                : typedInput.channelSecret
                  ? { channelSecret: typedInput.channelSecret }
                  : {}),
            },
      });
    }
    return patchLineAccountConfig({
      cfg,
      accountId: normalizedAccountId,
      enabled: true,
      patch: {
        ...(typedInput.tokenFile
          ? { tokenFile: typedInput.tokenFile }
          : accessToken
            ? { channelAccessToken: accessToken }
            : {}),
        ...(typedInput.secretFile
          ? { secretFile: typedInput.secretFile }
          : typedInput.channelSecret
            ? { channelSecret: typedInput.channelSecret }
            : {}),
      },
    });
  },
};

export const lineSetupContract = defineChannelSetupContract({
  fields: {
    channelAccessToken: {
      kind: "string",
      sensitive: true,
      cli: { flags: "--channel-access-token <token>", description: "LINE channel access token" },
    },
    // Shipped alias: released CLIs configured LINE via the shared `--token`
    // envelope switch; the adapter maps it onto channelAccessToken.
    token: {
      kind: "string",
      sensitive: true,
      cli: { flags: "--token <token>", description: "LINE channel access token (alias)" },
    },
    channelSecret: {
      kind: "string",
      sensitive: true,
      cli: { flags: "--channel-secret <secret>", description: "LINE channel secret" },
    },
    tokenFile: {
      kind: "string",
      sensitive: true,
      cli: { flags: "--token-file <path>", description: "LINE access token file" },
    },
    secretFile: {
      kind: "string",
      sensitive: true,
      cli: { flags: "--secret-file <path>", description: "LINE channel secret file" },
    },
    useEnv: {
      kind: "boolean",
      cli: { flags: "--use-env", description: "Use LINE environment credentials" },
    },
  },
  legacyAdapter: lineSetupAdapter,
});

export { listLineAccountIds };
