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
    const useEnv = normalizedAccountId === DEFAULT_ACCOUNT_ID && Boolean(typedInput.useEnv);
    // A credential resolves from the inline value first and only then from its
    // file, so writing one form has to retire the other. Leaving both behind
    // makes a rotation onto a file a silent no-op: the stale inline value keeps
    // winning and setup still reports success.
    const credentials = [
      {
        fileKey: "tokenFile",
        file: typedInput.tokenFile,
        inlineKey: "channelAccessToken",
        inline: accessToken,
      },
      {
        fileKey: "secretFile",
        file: typedInput.secretFile,
        inlineKey: "channelSecret",
        inline: typedInput.channelSecret,
      },
    ] as const;
    const patch: Record<string, string> = {};
    const retired: string[] = [];
    for (const credential of credentials) {
      if (credential.file) {
        patch[credential.fileKey] = credential.file;
        retired.push(credential.inlineKey);
      } else if (credential.inline) {
        patch[credential.inlineKey] = credential.inline;
        retired.push(credential.fileKey);
      }
    }
    return patchLineAccountConfig({
      cfg,
      accountId: normalizedAccountId,
      enabled: true,
      clearFields: useEnv
        ? ["channelAccessToken", "channelSecret", "tokenFile", "secretFile"]
        : retired.length > 0
          ? retired
          : undefined,
      patch: useEnv ? {} : patch,
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
      envVars: ["LINE_CHANNEL_ACCESS_TOKEN", "LINE_CHANNEL_SECRET"],
    },
  },
  legacyAdapter: lineSetupAdapter,
});

export { listLineAccountIds };
