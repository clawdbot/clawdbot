// Feishu needs core initial-dispatch cancellation to see the drain's signal
// via replyOptions.abortSignal, but the shared binding deliberately keeps that
// surface out of its return shape: irc and nextcloud-talk spread the whole
// return value into their replyOptions, so an extra field there would change
// their dispatch behavior. Feishu re-attaches the drain's own signal
// explicitly; the drain aborts it only while pre-adoption, so an adopted run
// is never cancelled through this surface.
import { bindIngressLifecycleToReplyOptions } from "openclaw/plugin-sdk/channel-outbound";

export function bindFeishuLifecycleToReplyOptions(
  lifecycle: Parameters<typeof bindIngressLifecycleToReplyOptions>[0],
) {
  return {
    ...bindIngressLifecycleToReplyOptions(lifecycle),
    abortSignal: lifecycle.abortSignal,
  };
}
