import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  hasConfiguredUnavailableCredentialStatus,
  hasResolvedCredentialValue,
} from "./account-snapshot-fields.js";
import {
  resolveChannelAccountConfigured,
  resolveChannelAccountEnabled,
} from "./account-summary.js";
import type { ChannelPlugin } from "./plugins/types.plugin.js";
import { inspectReadOnlyChannelAccount } from "./read-only-account-inspect.js";

type AccountInspectionFields = {
  enabled?: boolean;
  configured?: boolean;
} | null;

export async function inspectChannelAccount(params: {
  plugin: ChannelPlugin;
  cfg: OpenClawConfig;
  accountId: string;
}): Promise<unknown> {
  return (
    params.plugin.config.inspectAccount?.(params.cfg, params.accountId) ??
    (await inspectReadOnlyChannelAccount({
      channelId: params.plugin.id,
      cfg: params.cfg,
      accountId: params.accountId,
    }))
  );
}

export async function resolveInspectedChannelAccount(params: {
  plugin: ChannelPlugin;
  cfg: OpenClawConfig;
  sourceConfig: OpenClawConfig;
  accountId: string;
}): Promise<{
  account: unknown;
  enabled: boolean;
  configured: boolean;
}> {
  const sourceInspectedAccount = await inspectChannelAccount({
    plugin: params.plugin,
    cfg: params.sourceConfig,
    accountId: params.accountId,
  });
  const resolvedInspectedAccount = await inspectChannelAccount({
    plugin: params.plugin,
    cfg: params.cfg,
    accountId: params.accountId,
  });
  const resolvedInspection = resolvedInspectedAccount as AccountInspectionFields;
  const sourceInspection = sourceInspectedAccount as AccountInspectionFields;
  const resolvedAccount =
    resolvedInspectedAccount ?? params.plugin.config.resolveAccount(params.cfg, params.accountId);
  const useSourceUnavailableAccount = Boolean(
    sourceInspectedAccount &&
    hasConfiguredUnavailableCredentialStatus(sourceInspectedAccount) &&
    (!hasResolvedCredentialValue(resolvedAccount) ||
      (sourceInspection?.configured === true && resolvedInspection?.configured === false)),
  );
  const account = useSourceUnavailableAccount ? sourceInspectedAccount : resolvedAccount;
  const selectedInspection = useSourceUnavailableAccount ? sourceInspection : resolvedInspection;
  const enabled =
    selectedInspection?.enabled ??
    resolveChannelAccountEnabled({ plugin: params.plugin, account, cfg: params.cfg });
  const configured =
    selectedInspection?.configured ??
    (await resolveChannelAccountConfigured({
      plugin: params.plugin,
      account,
      cfg: params.cfg,
      readAccountConfiguredField: true,
    }));
  return { account, enabled, configured };
}
