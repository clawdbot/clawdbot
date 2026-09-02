import {
  addWildcardAllowFrom,
  patchChannelConfigForAccount,
} from "../channels/plugins/setup-wizard-helpers.js";
import type { ChannelSetupDmPolicy } from "../channels/plugins/setup-wizard-types.js";
import type { ChannelSetupAdapter } from "../channels/plugins/types.adapters.js";
import type { ChannelId } from "../channels/plugins/types.core.js";
// Shared account-aware DM policy descriptors for channel setup surfaces.
import type { DmPolicy } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";

type DmPolicyAccountConfig = {
  dmPolicy?: DmPolicy;
  allowFrom?: ReadonlyArray<string | number> | null;
};

type ResolvedDmPolicyAccount<TConfig extends DmPolicyAccountConfig> = {
  accountId: string;
  config: TConfig;
};

type DmPolicyContext<TConfig extends DmPolicyAccountConfig> = {
  cfg: OpenClawConfig;
  requestedAccountId?: string;
  account: ResolvedDmPolicyAccount<TConfig>;
};

type DmPolicyPatchContext<TConfig extends DmPolicyAccountConfig> = DmPolicyContext<TConfig> & {
  policy: DmPolicy;
  allowFrom?: string[];
};

type CreateChannelDmPolicyParams<TConfig extends DmPolicyAccountConfig> = {
  label: string;
  channel: ChannelId;
  policyKey?: string;
  allowFromKey?: string;
  policyPath?: string;
  allowFromPath?: string;
  resolveAccount: (cfg: OpenClawConfig, accountId?: string) => ResolvedDmPolicyAccount<TConfig>;
  resolveConfigKeys?: (context: DmPolicyContext<TConfig>) => {
    policyKey: string;
    allowFromKey: string;
  };
  resolveAllowFrom?: (context: DmPolicyPatchContext<TConfig>) => string[] | undefined;
  buildPatch?: (context: DmPolicyPatchContext<TConfig>) => Record<string, unknown>;
  applyPatch?: (
    context: DmPolicyContext<TConfig> & { patch: Record<string, unknown> },
  ) => OpenClawConfig;
  setupSurface?: ChannelSetupAdapter | (() => ChannelSetupAdapter);
  promptAllowFrom: NonNullable<ChannelSetupDmPolicy["promptAllowFrom"]>;
};

/** Build an account-aware DM policy descriptor for channel setup flows. */
export function createChannelDmPolicy<TConfig extends DmPolicyAccountConfig>(
  params: CreateChannelDmPolicyParams<TConfig>,
): ChannelSetupDmPolicy & {
  promptAllowFrom: NonNullable<ChannelSetupDmPolicy["promptAllowFrom"]>;
} {
  const policyPath = params.policyPath ?? "dmPolicy";
  const allowFromPath = params.allowFromPath ?? "allowFrom";
  const rootPath = `channels.${params.channel}`;
  const resolveContext = (cfg: OpenClawConfig, requestedAccountId?: string) => ({
    cfg,
    requestedAccountId,
    account: params.resolveAccount(cfg, requestedAccountId),
  });
  const resolveDefaultConfigKeys = (context: DmPolicyContext<TConfig>) => {
    const prefix =
      context.account.accountId === DEFAULT_ACCOUNT_ID
        ? rootPath
        : `${rootPath}.accounts.${context.account.accountId}`;
    return {
      policyKey: `${prefix}.${policyPath}`,
      allowFromKey: `${prefix}.${allowFromPath}`,
    };
  };

  return {
    label: params.label,
    channel: params.channel,
    policyKey: params.policyKey ?? `${rootPath}.${policyPath}`,
    allowFromKey: params.allowFromKey ?? `${rootPath}.${allowFromPath}`,
    resolveConfigKeys: (cfg, accountId) => {
      const context = resolveContext(cfg, accountId);
      return (params.resolveConfigKeys ?? resolveDefaultConfigKeys)(context);
    },
    getCurrent: (cfg, accountId) =>
      resolveContext(cfg, accountId).account.config.dmPolicy ?? "pairing",
    setPolicy: (cfg, policy, accountId) => {
      const context = resolveContext(cfg, accountId);
      const patchContext = {
        ...context,
        policy,
        allowFrom: params.resolveAllowFrom
          ? params.resolveAllowFrom({ ...context, policy })
          : policy === "open"
            ? addWildcardAllowFrom(context.account.config.allowFrom)
            : undefined,
      };
      const patch = params.buildPatch?.(patchContext) ?? {
        dmPolicy: policy,
        ...(patchContext.allowFrom === undefined ? {} : { allowFrom: patchContext.allowFrom }),
      };
      return params.applyPatch
        ? params.applyPatch({ ...context, patch })
        : patchChannelConfigForAccount({
            cfg,
            channel: params.channel,
            accountId: context.account.accountId,
            patch,
            setupSurface:
              typeof params.setupSurface === "function"
                ? params.setupSurface()
                : params.setupSurface,
          });
    },
    promptAllowFrom: params.promptAllowFrom,
  };
}
