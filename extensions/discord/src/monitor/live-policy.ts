import type { DiscordAccountConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { isDangerousNameMatchingEnabled } from "openclaw/plugin-sdk/dangerous-name-runtime";
import { createRuntimeConfigReader } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { createNonExitingRuntime, type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { resolveOpenProviderRuntimeGroupPolicy } from "openclaw/plugin-sdk/runtime-group-policy";
import {
  mergeDiscordAccountConfig,
  resolveDiscordAccountAllowFrom,
  resolveDiscordAccountDmPolicy,
} from "../accounts.js";
import { selectDiscordLivePolicyConfig } from "../live-policy-config.js";
import { resolveDiscordToken } from "../token.js";
import { resolveDiscordAllowlistConfig } from "./provider.allowlist.js";
import { resolveDiscordRestFetch } from "./rest-fetch.js";

type ResolvedAllowlist = Awaited<ReturnType<typeof resolveDiscordAllowlistConfig>>;
export type DiscordLivePolicy = {
  isCurrent: () => boolean;
  accountId: string;
  cfg: OpenClawConfig;
  discordConfig: DiscordAccountConfig;
  guildEntries: ResolvedAllowlist["guildEntries"];
  allowFrom: string[];
  dmPolicy: NonNullable<DiscordAccountConfig["dmPolicy"]>;
  groupPolicy: "open" | "allowlist" | "disabled";
  dmEnabled: boolean;
  groupDmEnabled: boolean;
  groupDmChannels: string[];
  allowNameMatching: boolean;
};
export type DiscordLivePolicyReader = () => Promise<DiscordLivePolicy>;

/** One reader belongs to one admitted account; transport and lifetime remain its startup owners. */
export function createDiscordLivePolicyReader(params: {
  cfg: OpenClawConfig;
  readConfig?: () => OpenClawConfig;
  accountId: string;
  discordConfig?: DiscordAccountConfig;
  token?: string;
  runtime?: RuntimeEnv;
  discordRestFetch?: typeof fetch;
  abortSignal?: AbortSignal;
  resolvedAllowlist?: ResolvedAllowlist;
}): DiscordLivePolicyReader {
  const readConfig = params.readConfig ?? createRuntimeConfigReader(params.cfg);
  const runtime = params.runtime ?? createNonExitingRuntime();
  const startupConfig =
    params.discordConfig ?? mergeDiscordAccountConfig(params.cfg, params.accountId);
  const token =
    params.token ?? resolveDiscordToken(params.cfg, { accountId: params.accountId }).token;
  const fetcher = params.discordRestFetch ?? resolveDiscordRestFetch(startupConfig.proxy, runtime);
  const startupPolicy = selectDiscordLivePolicyConfig(startupConfig);
  const authoredPolicyRevision = (cfg: OpenClawConfig) =>
    JSON.stringify({
      policy: selectDiscordLivePolicyConfig(mergeDiscordAccountConfig(cfg, params.accountId)),
      defaultGroupPolicy: cfg.channels?.defaults?.groupPolicy,
    });
  const initialAuthoredPolicyRevision = authoredPolicyRevision(params.cfg);
  // Public callers may supply prepared policy separately from cfg. Unrelated writes
  // preserve that seed; after an authored policy edit, omission means removal.
  let initialPolicyActive = true;
  let cachedConfig: OpenClawConfig | undefined;
  let cachedPolicy: DiscordLivePolicy | undefined;
  let resolutionKey = JSON.stringify({
    guildEntries: startupPolicy.guilds,
    allowFrom: startupConfig.allowFrom ?? resolveDiscordAccountAllowFrom(params),
    allowNameMatching: isDangerousNameMatchingEnabled(startupConfig),
  });
  let resolution = params.resolvedAllowlist ? Promise.resolve(params.resolvedAllowlist) : undefined;

  return async () => {
    for (;;) {
      params.abortSignal?.throwIfAborted();
      const cfg = readConfig();
      if (cfg === cachedConfig && cachedPolicy) {
        return cachedPolicy;
      }
      const authoredRevision = authoredPolicyRevision(cfg);
      if (initialPolicyActive && authoredRevision !== initialAuthoredPolicyRevision) {
        initialPolicyActive = false;
        cachedConfig = undefined;
      }
      const useInitialPolicy = initialPolicyActive;
      const merged = useInitialPolicy
        ? startupConfig
        : mergeDiscordAccountConfig(cfg, params.accountId);
      const discordConfig = { ...startupConfig, ...selectDiscordLivePolicyConfig(merged) };
      const allowFrom = useInitialPolicy
        ? (startupConfig.allowFrom ??
          resolveDiscordAccountAllowFrom({ cfg, accountId: params.accountId }))
        : resolveDiscordAccountAllowFrom({ cfg, accountId: params.accountId });
      const key = JSON.stringify({
        guildEntries: discordConfig.guilds,
        allowFrom,
        allowNameMatching: isDangerousNameMatchingEnabled(discordConfig),
      });
      if (!resolution || key !== resolutionKey) {
        resolutionKey = key;
        resolution = resolveDiscordAllowlistConfig({
          token,
          guildEntries: discordConfig.guilds,
          allowFrom,
          discordConfig,
          fetcher,
          runtime,
        });
      }
      const resolved = await resolution;
      params.abortSignal?.throwIfAborted();
      // An older REST result cannot admit traffic after a newer policy was published.
      if (cfg !== readConfig() || useInitialPolicy !== initialPolicyActive) {
        continue;
      }
      const { groupPolicy } = resolveOpenProviderRuntimeGroupPolicy({
        providerConfigPresent: cfg.channels?.discord !== undefined,
        groupPolicy: discordConfig.groupPolicy,
        defaultGroupPolicy: cfg.channels?.defaults?.groupPolicy,
      });
      cachedConfig = cfg;
      cachedPolicy = {
        isCurrent: () => {
          if (params.abortSignal?.aborted || useInitialPolicy !== initialPolicyActive) {
            return false;
          }
          const currentConfig = readConfig();
          return (
            cfg === currentConfig || authoredRevision === authoredPolicyRevision(currentConfig)
          );
        },
        accountId: params.accountId,
        cfg,
        discordConfig: { ...discordConfig, groupPolicy, guilds: resolved.guildEntries },
        guildEntries: resolved.guildEntries,
        allowFrom: resolved.allowFrom ?? [],
        dmPolicy:
          (useInitialPolicy ? startupConfig.dmPolicy : undefined) ??
          resolveDiscordAccountDmPolicy({ cfg, accountId: params.accountId }) ??
          "pairing",
        groupPolicy,
        dmEnabled: discordConfig.dm?.enabled ?? true,
        groupDmEnabled: discordConfig.dm?.groupEnabled ?? false,
        groupDmChannels: discordConfig.dm?.groupChannels ?? [],
        allowNameMatching: isDangerousNameMatchingEnabled(discordConfig),
      };
      return cachedPolicy;
    }
  };
}
