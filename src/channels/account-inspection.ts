/**
 * Channel account inspection helpers.
 *
 * Combines plugin inspection hooks, read-only fallbacks, and configured credential status.
 */
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  hasConfiguredUnavailableCredentialStatus,
  hasResolvedCredentialValue,
} from "./account-snapshot-fields.js";
import {
  buildChannelAccountSnapshotFromInspection,
  buildChannelAccountSummary,
  resolveChannelAccountConfigured,
  resolveChannelAccountEnabled,
} from "./account-summary.js";
import type { ChannelPlugin } from "./plugins/types.plugin.js";
import type { ChannelAccountSnapshot } from "./plugins/types.public.js";
import { inspectReadOnlyChannelAccount } from "./read-only-account-inspect.js";
import { resolveUnavailableChannelAccountSnapshot } from "./status/account-state.js";

export type ChannelAccountInspectionResult = {
  kind: "inspected" | "resolved" | "unavailable";
  account: unknown;
  enabled: boolean;
  configured: boolean | undefined;
  snapshot: ChannelAccountSnapshot;
};

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
}): Promise<ChannelAccountInspectionResult> {
  const unavailable = resolveUnavailableChannelAccountSnapshot({
    channelId: params.plugin.id,
    accountId: params.accountId,
  });
  if (unavailable) {
    return {
      kind: "unavailable",
      account: unavailable,
      enabled: unavailable.enabled !== false,
      configured: unavailable.configured === true,
      snapshot: unavailable,
    };
  }
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
  const resolvedInspection = asNullableRecord(resolvedInspectedAccount);
  const sourceInspection = asNullableRecord(sourceInspectedAccount);
  // When a source config says a credential exists but this process cannot resolve it, keep the
  // unavailable source snapshot so status can distinguish "configured" from "missing".
  const useSourceUnavailableAccount = Boolean(
    sourceInspectedAccount &&
    hasConfiguredUnavailableCredentialStatus(sourceInspectedAccount) &&
    (!hasResolvedCredentialValue(resolvedInspectedAccount) ||
      (sourceInspection?.configured === true && resolvedInspection?.configured === false)),
  );
  const inspected = useSourceUnavailableAccount ? sourceInspectedAccount : resolvedInspectedAccount;
  if (inspected != null) {
    const snapshot = buildChannelAccountSnapshotFromInspection({
      account: inspected,
      accountId: params.accountId,
    });
    return {
      kind: "inspected",
      account: inspected,
      enabled: snapshot.enabled !== false,
      configured: snapshot.configured,
      snapshot,
    };
  }
  const account = params.plugin.config.resolveAccount(params.cfg, params.accountId);
  const enabled = resolveChannelAccountEnabled({ plugin: params.plugin, account, cfg: params.cfg });
  const configured = await resolveChannelAccountConfigured({
    plugin: params.plugin,
    account,
    cfg: params.cfg,
    readAccountConfiguredField: true,
  });
  const snapshot = buildChannelAccountSummary({ ...params, account, enabled, configured });
  return { kind: "resolved", account, enabled, configured, snapshot };
}
