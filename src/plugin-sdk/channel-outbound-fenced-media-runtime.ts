/**
 * Private-local bundled-channel seam for fenced MEDIA skip diagnostics.
 *
 * Not a public third-party Plugin SDK contract. Bundled Telegram/Slack/Signal
 * direct paths share the accepted-delivery warn helper without expanding
 * `openclaw/plugin-sdk/channel-outbound` or public `reply-payload`.
 */
export { warnFencedMediaSkipsForAcceptedOutboundDelivery } from "./channel-outbound-fenced-media-warn.js";
export { createDirectAcceptedFencedMediaWarnLatch } from "./channel-outbound-fenced-media-latch.js";
