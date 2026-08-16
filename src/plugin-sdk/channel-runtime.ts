// Channel runtime contracts: typing indicators, reply prefixes, account status
// sinks, and long-poll lifecycle helpers used by external channel plugins.
//
// These helpers were consolidated into channel-outbound during the refactor
// that removed this subpath from the plugin SDK surface. Keep this alias so
// external plugins built against released packages (e.g.
// @tencent-weixin/openclaw-weixin, which imports createTypingCallbacks here)
// keep resolving on source checkouts of main.
export {
  createAccountStatusSink,
  createReplyPrefixContext,
  createReplyPrefixOptions,
  createTypingCallbacks,
  keepHttpServerTaskAlive,
  waitUntilAbort,
} from "./channel-outbound.js";
