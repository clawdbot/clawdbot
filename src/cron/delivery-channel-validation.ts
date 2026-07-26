// Channel-aware cron delivery validation for gateway-owned mutations.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { listConfiguredMessageChannels } from "../infra/outbound/channel-selection.js";
import {
  resolveTargetPrefixedChannel,
  validateTargetProviderPrefix,
} from "../infra/outbound/channel-target-prefix.js";
import { isDeliverableMessageChannel, normalizeMessageChannel } from "../utils/message-channel.js";
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
  const configuredChannels = (await listConfiguredMessageChannels(params.cfg)).toSorted();
  const normalizedChannel = normalizeMessageChannel(params.channel);
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
  const failureAlert = params.failureAlert;
  const globalFailureAlert = params.cfg.cron?.failureAlert;
  // `false` disables alerts. An unset job alert still inherits an enabled global
  // alert, so validate its effective route rather than allowing it to bypass the
  // same channel checks as an explicit per-job alert.
  if (failureAlert === false || (!failureAlert && globalFailureAlert?.enabled !== true)) {
    return;
  }
  // Only announce alerts route through a channel type; webhook alerts POST to
  // `to`. Resolve the effective mode exactly as runtime does in
  // resolveFailureAlert(): a job that omits `mode` inherits the global cron
  // failure-alert mode, so validating with a hard "announce" default would
  // wrongly reject a channel that a globally webhook-mode alert never uses.
  const effectiveMode = failureAlert?.mode ?? globalFailureAlert?.mode;
  if (effectiveMode === "webhook") {
    return;
  }
  // Mirror resolveFailureAlert(): the alert inherits the job delivery channel and
  // `to`, then the final send channel is resolved from that effective (channel,
  // to) pair - a provider prefix in `to` only wins when the effective channel is
  // unset/"last". Inheriting even when the alert names no route of its own means a
  // routing-changing edit (e.g. flipping mode to announce) that activates a
  // legacy-invalid inherited delivery channel is rejected up front rather than
  // only when the alert fires.
  const effectiveChannel = failureAlert?.channel ?? params.delivery?.channel;
  const effectiveTo = failureAlert?.to ?? params.delivery?.to;
  const resolvedChannel =
    resolveAnnounceValidationChannel({
      channel: effectiveChannel,
      to: effectiveTo,
    }) ?? "last";
  assertCompatibleAnnounceTarget({
    channel: effectiveChannel,
    to: effectiveTo,
    field: "failureAlert.channel",
  });
  await assertConfiguredAnnounceChannel({
    cfg: params.cfg,
    channel: resolvedChannel,
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
