import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import type { ChannelAccountSnapshot, ChannelsStatusSnapshot } from "../../api/types.ts";

export function resolveChannelAccounts(
  channelAccounts: ChannelsStatusSnapshot["channelAccounts"] | null | undefined,
  channelId: string,
): ChannelAccountSnapshot[] {
  const accounts =
    channelAccounts && Object.hasOwn(channelAccounts, channelId) && channelAccounts[channelId];
  return Array.isArray(accounts) ? accounts : [];
}

export function channelSnapshotEntryIsActive(
  snapshot: ChannelsStatusSnapshot | null,
  channelId: string,
): boolean {
  if (!snapshot) {
    return false;
  }
  const status = asRecord(
    Object.hasOwn(snapshot.channels, channelId) ? snapshot.channels[channelId] : undefined,
  );
  if (status?.configured === true || status?.running === true || status?.connected === true) {
    return true;
  }
  return resolveChannelAccounts(snapshot.channelAccounts, channelId).some(
    (account) =>
      account.configured === true || account.running === true || account.connected === true,
  );
}

/** Matches the Channels hub's definition of a transport the operator already uses. */
export function channelSnapshotHasActiveChannel(snapshot: ChannelsStatusSnapshot | null): boolean {
  if (!snapshot) {
    return false;
  }
  const channelIds = new Set([
    ...snapshot.channelOrder,
    ...Object.keys(snapshot.channels),
    ...Object.keys(snapshot.channelAccounts),
  ]);
  return [...channelIds].some((channelId) => channelSnapshotEntryIsActive(snapshot, channelId));
}
