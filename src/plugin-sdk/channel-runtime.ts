// Channel runtime contracts: typing indicators, reply prefixes, account status
// sinks, and long-poll lifecycle helpers used by external channel plugins.
//
// These helpers were consolidated into channel-outbound during the refactor
// that removed this subpath from the plugin SDK surface. This deprecated alias
// is kept so external channel plugins published against released packages
// (which import these helpers from this subpath) keep resolving on source
// checkouts of main. New plugins should import from channel-outbound;
// this subpath is scheduled for removal in the 2026.10 release train.
export {
  createAccountStatusSink,
  createReplyPrefixContext,
  createReplyPrefixOptions,
  createTypingCallbacks,
  keepHttpServerTaskAlive,
  waitUntilAbort,
} from "./channel-outbound.js";
