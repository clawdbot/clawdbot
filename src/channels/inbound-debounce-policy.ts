/**
 * Channel inbound debounce policy.
 *
 * Decides when text events can be delayed/merged before agent dispatch.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isControlCommandMessage } from "../auto-reply/command-detection.js";
import type { CommandNormalizeOptions } from "../auto-reply/commands-registry.js";
import {
  createInboundDebouncer,
  resolveInboundDebounceMs,
  type InboundDebounceCreateParams,
} from "../auto-reply/inbound-debounce.js";
import type { OpenClawConfig } from "../config/types.js";

/** Returns true when an inbound text event is safe to debounce before dispatch. */
export function shouldDebounceTextInbound(params: {
  text: string | null | undefined;
  cfg: OpenClawConfig;
  hasMedia?: boolean;
  commandOptions?: CommandNormalizeOptions;
  allowDebounce?: boolean;
}): boolean {
  if (params.allowDebounce === false) {
    return false;
  }
  if (params.hasMedia) {
    // Media payloads carry per-message attachments; merging them into a debounced text batch can
    // detach the attachment metadata from the original inbound event.
    return false;
  }
  const text = normalizeOptionalString(params.text) ?? "";
  if (!text) {
    return false;
  }
  // Control commands must dispatch immediately so stop/abort/status requests are not delayed
  // behind normal conversation text.
  return !isControlCommandMessage(text, params.cfg, params.commandOptions);
}

/** Creates a channel-scoped inbound debouncer using config/default debounce timing. */
export function createChannelInboundDebouncer<T>(
  params: Omit<InboundDebounceCreateParams<T>, "debounceMs"> & {
    cfg: OpenClawConfig;
    channel: string;
    debounceMsOverride?: number;
  },
): {
  debounceMs: number;
  debouncer: ReturnType<typeof createInboundDebouncer<T>>;
} {
  const debounceMs = resolveInboundDebounceMs({
    cfg: params.cfg,
    channel: params.channel,
    overrideMs: params.debounceMsOverride,
  });
  const { cfg: _cfg, channel: _channel, debounceMsOverride: _override, ...rest } = params;
  // The lower-level debouncer only needs queue callbacks and timing. Strip config-only inputs so
  // future helper options do not accidentally leak into its runtime shape.
  const debouncer = createInboundDebouncer<T>({
    debounceMs,
    ...rest,
  });
  return { debounceMs, debouncer };
}
