import type { DmPolicy } from "../../config/types.base.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { DEFAULT_ACCOUNT_ID } from "../../routing/session-key.js";
import type { WizardPrompter } from "../../wizard/prompts.js";
import { resolveChannelDmAllowFrom, resolveChannelDmPolicy } from "./dm-access.js";
import {
  addWildcardAllowFrom,
  patchChannelConfigForAccount,
  promptResolvedAllowFrom,
  resolveSetupAccountId,
  splitSetupEntries,
} from "./setup-wizard-helpers.js";
import type { ChannelSetupDmPolicy } from "./setup-wizard-types.js";

type AllowFromResolution = {
  input: string;
  resolved: boolean;
  id?: string | null;
};

function patchLegacyChannelConfig(params: {
  cfg: OpenClawConfig;
  channel: string;
  patch: Record<string, unknown>;
}): OpenClawConfig {
  const channelConfig =
    (params.cfg.channels?.[params.channel] as Record<string, unknown> | undefined) ?? {};
  const dmConfig = (channelConfig.dm as Record<string, unknown> | undefined) ?? {};
  return {
    ...params.cfg,
    channels: {
      ...params.cfg.channels,
      [params.channel]: {
        ...channelConfig,
        ...params.patch,
        dm: {
          ...dmConfig,
          enabled: typeof dmConfig.enabled === "boolean" ? dmConfig.enabled : true,
        },
      },
    },
  };
}

function setLegacyChannelDmPolicy(params: {
  cfg: OpenClawConfig;
  channel: string;
  dmPolicy: DmPolicy;
}): OpenClawConfig {
  const channelConfig =
    (params.cfg.channels?.[params.channel] as Record<string, unknown> | undefined) ?? {};
  const existingAllowFrom = resolveChannelDmAllowFrom({ account: channelConfig });
  const allowFrom =
    params.dmPolicy === "open" ? addWildcardAllowFrom(existingAllowFrom) : undefined;
  return patchLegacyChannelConfig({
    cfg: params.cfg,
    channel: params.channel,
    patch: {
      dmPolicy: params.dmPolicy,
      ...(allowFrom ? { allowFrom } : {}),
    },
  });
}

/** @deprecated Compatibility for plugins published before setup policy became plugin-owned. */
export function createLegacyCompatChannelDmPolicy(params: {
  label: string;
  channel: string;
  promptAllowFrom?: ChannelSetupDmPolicy["promptAllowFrom"];
}): ChannelSetupDmPolicy {
  return {
    label: params.label,
    channel: params.channel,
    policyKey: `channels.${params.channel}.dmPolicy`,
    allowFromKey: `channels.${params.channel}.allowFrom`,
    resolveConfigKeys: (_cfg, accountId) =>
      accountId && accountId !== DEFAULT_ACCOUNT_ID
        ? {
            policyKey: `channels.${params.channel}.accounts.${accountId}.dmPolicy`,
            allowFromKey: `channels.${params.channel}.accounts.${accountId}.allowFrom`,
          }
        : {
            policyKey: `channels.${params.channel}.dmPolicy`,
            allowFromKey: `channels.${params.channel}.allowFrom`,
          },
    getCurrent: (cfg, accountId) => {
      const channelConfig =
        (cfg.channels?.[params.channel] as
          | {
              dmPolicy?: DmPolicy;
              dm?: { policy?: DmPolicy };
              accounts?: Record<string, { dmPolicy?: DmPolicy; dm?: { policy?: DmPolicy } }>;
            }
          | undefined) ?? {};
      const accountConfig =
        accountId && accountId !== DEFAULT_ACCOUNT_ID
          ? channelConfig.accounts?.[accountId]
          : undefined;
      return resolveChannelDmPolicy({
        account: accountConfig as Record<string, unknown> | undefined,
        parent: channelConfig as Record<string, unknown>,
        defaultPolicy: "pairing",
      }) as DmPolicy;
    },
    setPolicy: (cfg, policy, accountId) =>
      accountId && accountId !== DEFAULT_ACCOUNT_ID
        ? patchChannelConfigForAccount({
            cfg,
            channel: params.channel,
            accountId,
            patch: {
              dmPolicy: policy,
              ...(policy === "open"
                ? {
                    allowFrom: addWildcardAllowFrom(
                      resolveChannelDmAllowFrom({
                        account: (
                          cfg.channels?.[params.channel] as
                            | { accounts?: Record<string, Record<string, unknown>> }
                            | undefined
                        )?.accounts?.[accountId],
                        parent: cfg.channels?.[params.channel] as
                          | Record<string, unknown>
                          | undefined,
                      }),
                    ),
                  }
                : {}),
            },
          })
        : setLegacyChannelDmPolicy({
            cfg,
            channel: params.channel,
            dmPolicy: policy,
          }),
    ...(params.promptAllowFrom ? { promptAllowFrom: params.promptAllowFrom } : {}),
  };
}

/** @deprecated Compatibility for plugins published before setup allowlists became plugin-owned. */
export async function promptLegacyChannelAllowFromForAccount<TAccount>(params: {
  cfg: OpenClawConfig;
  channel: string;
  prompter: WizardPrompter;
  accountId?: string;
  defaultAccountId: string;
  resolveAccount: (cfg: OpenClawConfig, accountId: string) => TAccount;
  resolveExisting: (account: TAccount, cfg: OpenClawConfig) => Array<string | number>;
  resolveToken: (account: TAccount) => string | null | undefined;
  noteTitle: string;
  noteLines: string[];
  message: string;
  placeholder: string;
  parseId: (value: string) => string | null;
  invalidWithoutTokenNote: string;
  resolveEntries: (params: { token: string; entries: string[] }) => Promise<AllowFromResolution[]>;
}): Promise<OpenClawConfig> {
  const accountId = resolveSetupAccountId({
    accountId: params.accountId,
    defaultAccountId: params.defaultAccountId,
  });
  const account = params.resolveAccount(params.cfg, accountId);
  await params.prompter.note(params.noteLines.join("\n"), params.noteTitle);
  const allowFrom = await promptResolvedAllowFrom({
    prompter: params.prompter,
    existing: params.resolveExisting(account, params.cfg),
    token: params.resolveToken(account),
    message: params.message,
    placeholder: params.placeholder,
    label: params.noteTitle,
    parseInputs: splitSetupEntries,
    parseId: params.parseId,
    invalidWithoutTokenNote: params.invalidWithoutTokenNote,
    resolveEntries: params.resolveEntries,
  });
  return patchLegacyChannelConfig({
    cfg: params.cfg,
    channel: params.channel,
    patch: { allowFrom },
  });
}
