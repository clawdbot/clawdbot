import {
  addWildcardAllowFrom,
  createSetupInputPresenceValidator,
  normalizeAccountId,
  patchScopedAccountConfig,
  prepareScopedSetupConfig,
  type ChannelSetupAdapter,
  type DmPolicy,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/setup";
import { applyBlueBubblesConnectionConfig } from "./config-apply.js";

const channel = "bluebubbles" as const;

export function setBlueBubblesDmPolicy(
  cfg: OpenClawConfig,
  accountId: string,
  dmPolicy: DmPolicy,
): OpenClawConfig {
  const resolvedAccountId = normalizeAccountId(accountId);
  const existingAllowFrom =
    resolvedAccountId === "default"
      ? cfg.channels?.bluebubbles?.allowFrom
      : ((
          cfg.channels?.bluebubbles?.accounts?.[resolvedAccountId] as
            | { allowFrom?: ReadonlyArray<string | number> }
            | undefined
        )?.allowFrom ?? cfg.channels?.bluebubbles?.allowFrom);
  return patchScopedAccountConfig({
    cfg,
    channelKey: channel,
    accountId: resolvedAccountId,
    patch: {
      dmPolicy,
      ...(dmPolicy === "open" ? { allowFrom: addWildcardAllowFrom(existingAllowFrom) } : {}),
    },
    ensureChannelEnabled: false,
    ensureAccountEnabled: false,
  });
}

export function setBlueBubblesAllowFrom(
  cfg: OpenClawConfig,
  accountId: string,
  allowFrom: string[],
): OpenClawConfig {
  return patchScopedAccountConfig({
    cfg,
    channelKey: channel,
    accountId,
    patch: { allowFrom },
    ensureChannelEnabled: false,
    ensureAccountEnabled: false,
  });
}

export const blueBubblesSetupAdapter: ChannelSetupAdapter = {
  resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
  applyAccountName: ({ cfg, accountId, name }) =>
    prepareScopedSetupConfig({
      cfg,
      channelKey: channel,
      accountId,
      name,
    }),
  validateInput: createSetupInputPresenceValidator({
    validate: ({ input }) => {
      if (!input.httpUrl && !input.password) {
        return "BlueBubbles requires --http-url and --password.";
      }
      if (!input.httpUrl) {
        return "BlueBubbles requires --http-url.";
      }
      if (!input.password) {
        return "BlueBubbles requires --password.";
      }
      return null;
    },
  }),
  applyAccountConfig: ({ cfg, accountId, input }) => {
    const next = prepareScopedSetupConfig({
      cfg,
      channelKey: channel,
      accountId,
      name: input.name,
      migrateBaseName: true,
    });
    return applyBlueBubblesConnectionConfig({
      cfg: next,
      accountId,
      patch: {
        serverUrl: input.httpUrl,
        password: input.password,
        webhookPath: input.webhookPath,
      },
      onlyDefinedFields: true,
    });
  },
};
