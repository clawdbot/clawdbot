import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { inspectChannelAccount } from "../account-inspection.js";
import { projectSafeChannelAccountSnapshotFields } from "../account-snapshot-fields.js";
import type { ChannelPlugin } from "./types.plugin.js";
import type { ChannelAccountSnapshot } from "./types.public.js";

// Channel docking: status snapshots flow through plugin.status hooks here.
export async function buildChannelAccountSnapshotFromAccount<ResolvedAccount>(params: {
  plugin: ChannelPlugin<ResolvedAccount>;
  cfg: OpenClawConfig;
  accountId: string;
  account: ResolvedAccount;
  runtime?: ChannelAccountSnapshot;
  probe?: unknown;
  audit?: unknown;
  enabledFallback?: boolean;
  configuredFallback?: boolean;
}): Promise<ChannelAccountSnapshot> {
  let snapshot: ChannelAccountSnapshot;
  if (params.plugin.status?.buildAccountSnapshot) {
    snapshot = await params.plugin.status.buildAccountSnapshot({
      account: params.account,
      cfg: params.cfg,
      runtime: params.runtime,
      probe: params.probe,
      audit: params.audit,
    });
  } else {
    const enabled = params.plugin.config.isEnabled
      ? params.plugin.config.isEnabled(params.account, params.cfg)
      : params.account && typeof params.account === "object"
        ? (params.account as { enabled?: boolean }).enabled
        : undefined;
    const configured =
      params.account && typeof params.account === "object" && "configured" in params.account
        ? (params.account as { configured?: boolean }).configured
        : params.plugin.config.isConfigured
          ? await params.plugin.config.isConfigured(params.account, params.cfg)
          : undefined;
    snapshot = {
      accountId: params.accountId,
      enabled,
      configured,
      ...projectSafeChannelAccountSnapshotFields(params.account),
      ...projectSafeChannelAccountSnapshotFields(params.runtime),
    };
  }

  return {
    ...snapshot,
    accountId: normalizeOptionalString(snapshot.accountId) ? snapshot.accountId : params.accountId,
    enabled: snapshot.enabled ?? params.enabledFallback,
    configured: snapshot.configured ?? params.configuredFallback,
    ...(params.probe !== undefined && snapshot.probe === undefined ? { probe: params.probe } : {}),
  };
}

export async function buildReadOnlySourceChannelAccountSnapshot<ResolvedAccount>(params: {
  plugin: ChannelPlugin<ResolvedAccount>;
  cfg: OpenClawConfig;
  accountId: string;
  runtime?: ChannelAccountSnapshot;
  probe?: unknown;
  audit?: unknown;
}): Promise<ChannelAccountSnapshot | null> {
  const inspectedAccount = await inspectChannelAccount(params);
  if (!inspectedAccount) {
    return null;
  }
  return await buildChannelAccountSnapshotFromAccount({
    ...params,
    account: inspectedAccount as ResolvedAccount,
  });
}

export async function buildChannelAccountSnapshot<ResolvedAccount>(params: {
  plugin: ChannelPlugin<ResolvedAccount>;
  cfg: OpenClawConfig;
  accountId: string;
  runtime?: ChannelAccountSnapshot;
  probe?: unknown;
  audit?: unknown;
}): Promise<ChannelAccountSnapshot> {
  const inspectedAccount = await inspectChannelAccount(params);
  const account = (inspectedAccount ??
    params.plugin.config.resolveAccount(params.cfg, params.accountId)) as ResolvedAccount;
  return await buildChannelAccountSnapshotFromAccount({
    ...params,
    account,
  });
}
