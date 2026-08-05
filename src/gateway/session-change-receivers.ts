import { hasPluginSessionsChangedSubscribers } from "../plugins/gateway-events.js";

/** Native plugin listeners remain session-change receivers without a websocket client. */
export function hasSessionChangeReceivers(connIds: ReadonlySet<string>): boolean {
  return connIds.size > 0 || hasPluginSessionsChangedSubscribers();
}
