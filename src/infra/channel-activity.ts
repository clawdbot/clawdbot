// Tracks last inbound/outbound activity for channel accounts.
import type { ChannelId } from "../channels/plugins/channel-id.types.js";

/** Direction of the last observed activity for a channel/account pair. */
export type ChannelDirection = "inbound" | "outbound";

type ActivityEntry = {
  inboundAt: number | null;
  outboundAt: number | null;
};

const activity = new Map<string, ActivityEntry>();

function keyFor(channel: ChannelId, accountId: string) {
  // Account ids are normalized before keying so omitted/blank ids share the default account slot.
  return `${channel}:${accountId || "default"}`;
}

function ensureEntry(channel: ChannelId, accountId: string): ActivityEntry {
  const key = keyFor(channel, accountId);
  const existing = activity.get(key);
  if (existing) {
    return existing;
  }
  const created: ActivityEntry = { inboundAt: null, outboundAt: null };
  activity.set(key, created);
  return created;
}

/** Records the latest inbound or outbound activity timestamp for a channel/account. */
export function recordChannelActivity(params: {
  channel: ChannelId;
  accountId?: string | null;
  direction: ChannelDirection;
  at?: number;
}) {
  const at = typeof params.at === "number" ? params.at : Date.now();
  const accountId = params.accountId?.trim() || "default";
  const entry = ensureEntry(params.channel, accountId);
  if (params.direction === "inbound") {
    entry.inboundAt = at;
  }
  if (params.direction === "outbound") {
    entry.outboundAt = at;
  }
}

/** Returns the latest known inbound/outbound activity timestamps for a channel/account. */
export function getChannelActivity(params: {
  channel: ChannelId;
  accountId?: string | null;
}): ActivityEntry {
  const accountId = params.accountId?.trim() || "default";
  return (
    activity.get(keyFor(params.channel, accountId)) ?? {
      inboundAt: null,
      outboundAt: null,
    }
  );
}

/** Clears all tracked channel activity; test-only helper. */
export function resetChannelActivityForTest() {
  activity.clear();
}
