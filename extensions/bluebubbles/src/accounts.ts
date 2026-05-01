import {
  createAccountListHelpers,
  normalizeAccountId,
  resolveMergedAccountConfig,
} from "openclaw/plugin-sdk/account-resolution";
import { resolveChannelStreamingChunkMode } from "openclaw/plugin-sdk/channel-streaming";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import {
  normalizeBlueBubblesAccountsMap,
  normalizeBlueBubblesPrivateNetworkAliases,
  resolveBlueBubblesEffectiveAllowPrivateNetworkFromConfig,
  resolveBlueBubblesPrivateNetworkConfigValue as resolveBlueBubblesPrivateNetworkConfigValueFromRecord,
} from "./accounts-normalization.js";
import { hasConfiguredSecretInput, normalizeSecretInputString } from "./secret-input.js";
import { normalizeBlueBubblesServerUrl, type BlueBubblesAccountConfig } from "./types.js";

export type ResolvedBlueBubblesAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  config: BlueBubblesAccountConfig;
  configured: boolean;
  baseUrl?: string;
};

const {
  listAccountIds: listBlueBubblesAccountIds,
  resolveDefaultAccountId: resolveDefaultBlueBubblesAccountId,
} = createAccountListHelpers("bluebubbles");
export { listBlueBubblesAccountIds, resolveDefaultBlueBubblesAccountId };

function mergeBlueBubblesAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): BlueBubblesAccountConfig {
  const channelConfig = normalizeBlueBubblesPrivateNetworkAliases(
    cfg.channels?.bluebubbles as BlueBubblesAccountConfig | undefined,
  );
  const accounts = normalizeBlueBubblesAccountsMap(
    cfg.channels?.bluebubbles?.accounts as
      | Record<string, Partial<BlueBubblesAccountConfig>>
      | undefined,
  );
  const merged = resolveMergedAccountConfig<BlueBubblesAccountConfig>({
    channelConfig,
    accounts,
    accountId,
    omitKeys: ["defaultAccount"],
    normalizeAccountId,
    nestedObjectKeys: ["network", "catchup"],
  });
  return {
    ...merged,
    chunkMode: resolveChannelStreamingChunkMode(merged) ?? merged.chunkMode ?? "length",
  };
}

export function resolveBlueBubblesAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedBlueBubblesAccount {
  const accountId = normalizeAccountId(
    params.accountId ?? resolveDefaultBlueBubblesAccountId(params.cfg),
  );
  const baseEnabled = params.cfg.channels?.bluebubbles?.enabled;
  const merged = mergeBlueBubblesAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const serverUrl = normalizeSecretInputString(merged.serverUrl);
  const _password = normalizeSecretInputString(merged.password);
  const configured = Boolean(serverUrl && hasConfiguredSecretInput(merged.password));
  const baseUrl = serverUrl ? normalizeBlueBubblesServerUrl(serverUrl) : undefined;
  return {
    accountId,
    enabled: baseEnabled !== false && accountEnabled,
    name: normalizeOptionalString(merged.name),
    config: merged,
    configured,
    baseUrl,
  };
}

export function resolveBlueBubblesPrivateNetworkConfigValue(
  config: BlueBubblesAccountConfig | null | undefined,
): boolean | undefined {
  return resolveBlueBubblesPrivateNetworkConfigValueFromRecord(config);
}

export function resolveBlueBubblesEffectiveAllowPrivateNetwork(params: {
  baseUrl?: string;
  config?: BlueBubblesAccountConfig | null;
}): boolean {
  return resolveBlueBubblesEffectiveAllowPrivateNetworkFromConfig(params);
}
