import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import type { ClickClackDiscussionBinding } from "./binding-store.js";

type RevokedDiscussionChannel = {
  accountId: string;
  serverBaseUrl: string;
  channelId: string;
  revokedAt: number;
};

const REVOKED_CHANNELS_NAMESPACE = "discussion-revoked-channels";
const MAX_REVOKED_CHANNELS = 100_000;
const storesByRuntime = new WeakMap<
  PluginRuntime,
  PluginStateSyncKeyedStore<RevokedDiscussionChannel>
>();

function revokedChannelKey(params: { serverBaseUrl: string; channelId: string }): string {
  return [params.serverBaseUrl.replace(/\/+$/u, ""), params.channelId].join("\0");
}

function getStore(runtime: PluginRuntime): PluginStateSyncKeyedStore<RevokedDiscussionChannel> {
  const existing = storesByRuntime.get(runtime);
  if (existing) {
    return existing;
  }
  const created = runtime.state.openSyncKeyedStore<RevokedDiscussionChannel>({
    namespace: REVOKED_CHANNELS_NAMESPACE,
    maxEntries: MAX_REVOKED_CHANNELS,
    // These markers are the authorization boundary for released channels that
    // could not be archived. At capacity, retain old evidence and fail the new
    // lifecycle mutation closed instead of allowing delayed inbound fallthrough.
    overflowPolicy: "reject-new",
  });
  storesByRuntime.set(runtime, created);
  return created;
}

/** Records managed ownership before its live binding is released. */
export function markClickClackDiscussionChannelRevoked(
  runtime: PluginRuntime,
  binding: ClickClackDiscussionBinding,
): void {
  const value: RevokedDiscussionChannel = {
    accountId: binding.accountId,
    serverBaseUrl: binding.serverBaseUrl,
    channelId: binding.channelId,
    revokedAt: Date.now(),
  };
  getStore(runtime).register(revokedChannelKey(value), value);
}

export function markClickClackDiscussionChannelIdentityRevoked(params: {
  runtime: PluginRuntime;
  accountId: string;
  serverBaseUrl: string;
  channelId: string;
}): void {
  const value: RevokedDiscussionChannel = {
    accountId: params.accountId,
    serverBaseUrl: params.serverBaseUrl.replace(/\/+$/u, ""),
    channelId: params.channelId,
    revokedAt: Date.now(),
  };
  getStore(params.runtime).register(revokedChannelKey(value), value);
}

export function clearClickClackDiscussionChannelRevoked(params: {
  runtime: PluginRuntime;
  serverBaseUrl: string;
  channelId: string;
}): void {
  getStore(params.runtime).delete(revokedChannelKey(params));
}

/** Distinguishes a released managed channel from a genuinely ordinary channel. */
export function isClickClackDiscussionChannelRevoked(params: {
  runtime: PluginRuntime;
  serverBaseUrl: string;
  channelId: string;
}): boolean {
  return Boolean(getStore(params.runtime).lookup(revokedChannelKey(params)));
}
