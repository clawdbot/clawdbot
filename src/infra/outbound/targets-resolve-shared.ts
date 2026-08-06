// Shared target resolution applies plugin defaults, allowlists, prefixes, and
// fallback errors for direct and loaded-channel send paths.
import { mapAllowFromEntries } from "openclaw/plugin-sdk/channel-config-helpers";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { ChannelOutboundTargetMode } from "../../channels/plugins/types.public.js";
import { formatCliCommand } from "../../cli/command-format.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel-constants.js";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import { validateTargetProviderPrefix } from "./channel-target-prefix.js";
import { missingTargetError, reservedTargetLiteralError } from "./target-errors.js";
import { resolveReservedTargetLiteral } from "./target-normalization.js";

/**
 * Result of resolving a concrete outbound target for a channel send.
 */
export type OutboundTargetResolution = { ok: true; to: string } | { ok: false; error: Error };

/**
 * Inputs shared by direct and heartbeat outbound target resolution.
 */
type ResolveOutboundTargetParams = {
  channel: GatewayMessageChannel;
  to?: string;
  allowFrom?: string[];
  cfg?: OpenClawConfig;
  accountId?: string | null;
  mode?: ChannelOutboundTargetMode;
};

function buildWebChatDeliveryError(): Error {
  return new Error(
    `Delivering to WebChat is not supported via \`${formatCliCommand("openclaw agent")}\`; use WhatsApp/Telegram or run with --deliver=false.`,
  );
}

/**
 * Resolves a target through a channel plugin or the generic fallback path.
 */
export function resolveOutboundTargetWithPlugin(params: {
  plugin: ChannelPlugin | undefined;
  target: ResolveOutboundTargetParams;
  onMissingPlugin?: () => OutboundTargetResolution | undefined;
}): OutboundTargetResolution | undefined {
  if (params.target.channel === INTERNAL_MESSAGE_CHANNEL) {
    return {
      ok: false,
      error: buildWebChatDeliveryError(),
    };
  }

  const plugin = params.plugin;
  if (!plugin) {
    return params.onMissingPlugin?.();
  }

  // Plugin defaults and allowlists can be account-scoped; resolve them before target validation.
  const allowFromRaw =
    params.target.allowFrom ??
    (params.target.cfg && plugin.config.resolveAllowFrom
      ? plugin.config.resolveAllowFrom({
          cfg: params.target.cfg,
          accountId: params.target.accountId ?? undefined,
        })
      : undefined);
  const allowFrom = allowFromRaw ? mapAllowFromEntries(allowFromRaw) : undefined;

  const effectiveTo =
    params.target.to?.trim() ||
    (params.target.cfg && plugin.config.resolveDefaultTo
      ? plugin.config.resolveDefaultTo({
          cfg: params.target.cfg,
          accountId: params.target.accountId ?? undefined,
        })
      : undefined);
  const targetPrefixError = validateTargetProviderPrefix({
    channel: params.target.channel,
    to: effectiveTo,
  });
  if (targetPrefixError) {
    return { ok: false, error: targetPrefixError };
  }
  const hint = plugin.messaging?.targetResolver?.hint;
  // Heartbeats defer reserved literals to the async resolver so directory hits can win.
  if (params.target.mode !== "heartbeat") {
    const reservedLiteral = resolveReservedTargetLiteral({ raw: effectiveTo, plugin });
    if (reservedLiteral) {
      return {
        ok: false,
        error: reservedTargetLiteralError(
          plugin.meta.label ?? params.target.channel,
          reservedLiteral,
          hint,
        ),
      };
    }
  }

  const resolveTarget = plugin.outbound?.resolveTarget;
  if (resolveTarget) {
    return resolveTarget({
      cfg: params.target.cfg,
      to: effectiveTo,
      allowFrom,
      accountId: params.target.accountId ?? undefined,
      mode: params.target.mode ?? "explicit",
    });
  }

  if (effectiveTo) {
    return { ok: true, to: effectiveTo };
  }
  return {
    ok: false,
    error: missingTargetError(plugin.meta.label ?? params.target.channel, hint),
  };
}
