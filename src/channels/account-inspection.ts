/**
 * Channel account inspection helpers.
 *
 * Combines plugin inspection hooks, read-only fallbacks, and configured credential status.
 */
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

/**
 * Inspects one channel account using the plugin hook or read-only fallback.
 */
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

/**
 * Resolves an inspected channel account plus enabled/configured state for status surfaces.
 */
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
  // When a source config says a credential exists but this process cannot resolve it, keep the
  // unavailable source snapshot so status can distinguish "configured" from "missing".
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
