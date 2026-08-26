/**
 * Channel status snapshot builders.
 *
 * Combines plugin status hooks, account inspection, and safe account field projection.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { inspectChannelAccount } from "../account-inspection.js";
import {
  projectSafeChannelAccountSnapshotFields,
  redactChannelAccountSnapshotBaseUrl,
} from "../account-snapshot-fields.js";
import {
  applyChannelAccountState,
  resolveChannelAccountLinked,
  resolveChannelAccountState,
} from "../status/account-state.js";
import type { ChannelPlugin } from "./types.plugin.js";
import type { ChannelAccountSnapshot } from "./types.public.js";

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
    snapshot = {
      accountId: params.accountId,
      ...projectSafeChannelAccountSnapshotFields(params.account),
      ...projectSafeChannelAccountSnapshotFields(params.runtime),
    };
  }

  const described = params.plugin.config.describeAccount?.(params.account, params.cfg);
  const enabled = params.plugin.config.isEnabled
    ? params.plugin.config.isEnabled(params.account, params.cfg)
    : (described?.enabled ?? snapshot.enabled ?? params.enabledFallback ?? true);
  const configured =
    described?.configured ??
    (params.plugin.config.isConfigured
      ? await params.plugin.config.isConfigured(params.account, params.cfg)
      : (snapshot.configured ?? params.configuredFallback ?? true));
  const linkState =
    configured && params.plugin.config.isLinked
      ? await params.plugin.config.isLinked(params.account, params.cfg)
      : undefined;
  const state = resolveChannelAccountState({
    enabled,
    configured,
    linked: resolveChannelAccountLinked(linkState, described?.linked ?? snapshot.linked),
    runtime: snapshot,
    disabledReason: params.plugin.config.disabledReason?.(params.account, params.cfg),
    unconfiguredReason: params.plugin.config.unconfiguredReason?.(params.account, params.cfg),
    unlinkedReason: params.plugin.config.unlinkedReason?.(params.account, params.cfg),
  });
  const projectedSnapshot = { ...snapshot };
  applyChannelAccountState(projectedSnapshot, state);
  return redactChannelAccountSnapshotBaseUrl({
    ...projectedSnapshot,
    enabled,
    accountId: normalizeOptionalString(snapshot.accountId) ? snapshot.accountId : params.accountId,
    ...(params.probe !== undefined && snapshot.probe === undefined ? { probe: params.probe } : {}),
  });
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

export async function resolveChannelAccountSnapshot<ResolvedAccount>(params: {
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
