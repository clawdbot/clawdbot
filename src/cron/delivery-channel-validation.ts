// Channel-aware cron delivery validation for gateway-owned mutations.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { listConfiguredMessageChannels } from "../infra/outbound/channel-selection.js";
import {
  resolveTargetPrefixedChannel,
  validateTargetProviderPrefix,
} from "../infra/outbound/channel-target-prefix.js";
import { normalizeAccountId } from "../routing/account-id.js";
import { resolveNormalizedAccountEntry } from "../routing/account-lookup.js";
import { isDeliverableMessageChannel, normalizeMessageChannel } from "../utils/message-channel.js";
import { resolveFailureAlert } from "./service/failure-alerts.js";
import type { CronDelivery, CronFailureAlert, CronJobCreate } from "./types.js";

function hasExplicitChannelConfigEntry(cfg: OpenClawConfig): boolean {
  const channels = cfg.channels;
  if (!channels || typeof channels !== "object" || Array.isArray(channels)) {
    return false;
  }
  return Object.entries(channels).some(([channelId, entry]) => {
    if (channelId === "defaults" || channelId === "modelByChannel") {
      return false;
    }
    return Boolean(
      entry && typeof entry === "object" && !Array.isArray(entry) && Object.keys(entry).length > 0,
    );
  });
}

async function assertConfiguredAnnounceChannel(params: {
  cfg: OpenClawConfig;
  channel?: string;
  field: "delivery.channel" | "delivery.failureDestination.channel" | "failureAlert.channel";
}) {
  if (params.channel === "last") {
    return;
  }
  const normalizedChannel = normalizeMessageChannel(params.channel);
  if (!normalizedChannel && params.field === "delivery.channel") {
    // Primary implicit routing is service-owned because session-backed and
    // best-effort jobs must remain valid even on multi-channel hosts.
    return;
  }
  const configuredChannels = (await listConfiguredMessageChannels(params.cfg)).toSorted();
  if (!normalizedChannel) {
    if (configuredChannels.length <= 1) {
      return;
    }
    throw new Error(
      `${params.field} is required when multiple channels are configured: ${configuredChannels.join(", ")}`,
    );
  }
  if (configuredChannels.length === 0) {
    if (!hasExplicitChannelConfigEntry(params.cfg)) {
      if (!isDeliverableMessageChannel(normalizedChannel)) {
        throw new Error(`${params.field} is not a known channel: ${normalizedChannel}`);
      }
      return;
    }
    throw new Error(`${params.field} is not configured: ${normalizedChannel}`);
  }
  if (!configuredChannels.includes(normalizedChannel)) {
    throw new Error(`${params.field} must be one of: ${configuredChannels.join(", ")}`);
  }
}

/**
 * Rejects an announce account the operator has turned off in config, so a job is
 * not scheduled against a route its owner already disabled - the same late failure
 * this file prevents for `channel` (see `assertValidCronFailureAlert`).
 *
 * Scoped to a matching `accounts.<id>.enabled: false` entry, and nothing else.
 * Cron delivery ids are not always operator-typed (`delivery-context.ts` copies
 * the current context account into inferred jobs); channel `isEnabled` adapters
 * report unlisted or credential-suppressed accounts as not enabled; and a
 * top-level `channels.<id>.enabled: false` is not uniformly channel-wide - twitch
 * resolves named accounts from `accounts` alone. Only the account entry itself is
 * an unambiguous statement about this route.
 */
function assertEnabledAnnounceAccount(params: {
  cfg: OpenClawConfig;
  channel?: string;
  accountId?: string;
  field: "delivery.accountId";
}) {
  if (!params.accountId || !params.channel || params.channel === "last") {
    return;
  }
  // Aliases are valid delivery channels (`urbit` -> `tlon`) but config lives under
  // the canonical id, so normalize before reading it.
  const channel = normalizeMessageChannel(params.channel) ?? params.channel;
  const channelConfig = (params.cfg.channels as Record<string, unknown> | undefined)?.[channel];
  if (!channelConfig || typeof channelConfig !== "object" || Array.isArray(channelConfig)) {
    return;
  }
  const accounts = (channelConfig as { accounts?: Record<string, { enabled?: unknown }> }).accounts;
  // Channels resolve account keys canonically (matrix `"Team Ops"` answers to
  // `team-ops`), so match the same way or a disabled entry is missed.
  if (
    resolveNormalizedAccountEntry(accounts, params.accountId, normalizeAccountId)?.enabled !== false
  ) {
    return;
  }
  throw new Error(
    `${params.field}: account "${params.accountId}" is disabled for channel ${channel}`,
  );
}

function resolveAnnounceValidationChannel(params: {
  channel?: string;
  to?: string;
}): string | undefined {
  return params.channel && params.channel !== "last"
    ? params.channel
    : (resolveTargetPrefixedChannel(params.to) ?? params.channel);
}

function assertCompatibleAnnounceTarget(params: {
  channel?: string;
  to?: string;
  field: "delivery.channel" | "delivery.failureDestination.channel" | "failureAlert.channel";
}) {
  if (!params.channel || params.channel === "last") {
    return;
  }
  const error = validateTargetProviderPrefix({ channel: params.channel, to: params.to });
  if (error) {
    throw new Error(`${params.field}: ${error.message}`);
  }
}

export async function assertValidCronAnnounceDelivery(params: {
  cfg: OpenClawConfig;
  delivery?: CronDelivery;
}) {
  if (params.delivery && (params.delivery.mode ?? "announce") === "announce") {
    assertCompatibleAnnounceTarget({
      channel: params.delivery.channel,
      to: params.delivery.to,
      field: "delivery.channel",
    });
    await assertConfiguredAnnounceChannel({
      cfg: params.cfg,
      channel: resolveAnnounceValidationChannel(params.delivery),
      field: "delivery.channel",
    });
    assertEnabledAnnounceAccount({
      cfg: params.cfg,
      channel: resolveAnnounceValidationChannel(params.delivery),
      accountId: params.delivery.accountId,
      field: "delivery.accountId",
    });
  }

  const failureDestination = params.delivery?.failureDestination;
  if (failureDestination && (failureDestination.mode ?? "announce") === "announce") {
    if (
      failureDestination.channel === undefined &&
      failureDestination.to === undefined &&
      failureDestination.accountId === undefined &&
      failureDestination.mode === undefined
    ) {
      return;
    }
    assertCompatibleAnnounceTarget({
      channel: failureDestination.channel,
      to: failureDestination.to,
      field: "delivery.failureDestination.channel",
    });
    await assertConfiguredAnnounceChannel({
      cfg: params.cfg,
      channel: resolveAnnounceValidationChannel(failureDestination),
      field: "delivery.failureDestination.channel",
    });
  }
}

/**
 * Validates the per-job `failureAlert` channel the same way announce delivery is
 * validated. `failureAlert` is a distinct field from `delivery.failureDestination`
 * (its own store columns and delivery path), so it needs its own check - otherwise
 * an explicit unknown channel (e.g. a Slack `C0...` id passed to
 * `--failure-alert-channel`) is stored and only fails later as `channel_not_found`.
 */
export async function assertValidCronFailureAlert(params: {
  cfg: OpenClawConfig;
  failureAlert?: CronFailureAlert | false;
  delivery?: CronDelivery;
}) {
  // Validate the scheduler-owned route so prefix, global, and inheritance
  // decisions cannot diverge between mutations and actual alert delivery.
  const failureAlert = resolveFailureAlert(
    { deps: { cronConfig: params.cfg.cron } },
    { delivery: params.delivery, failureAlert: params.failureAlert },
  );
  if (!failureAlert || failureAlert.mode === "webhook") {
    return;
  }
  assertCompatibleAnnounceTarget({
    channel: failureAlert.channel,
    to: failureAlert.to,
    field: "failureAlert.channel",
  });
  await assertConfiguredAnnounceChannel({
    cfg: params.cfg,
    channel: failureAlert.channel,
    field: "failureAlert.channel",
  });
}

export async function assertValidCronCreateDelivery(cfg: OpenClawConfig, job: CronJobCreate) {
  await assertValidCronAnnounceDelivery({ cfg, delivery: job.delivery });
  await assertValidCronFailureAlert({
    cfg,
    failureAlert: job.failureAlert,
    delivery: job.delivery,
  });
}
