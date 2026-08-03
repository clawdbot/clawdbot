/**
 * Channel directory adapter helpers.
 *
 * Provides null/empty defaults for plugins without directory support.
 */
import type { ChannelDirectoryAdapter } from "./types.adapters.js";

export const nullChannelDirectorySelf: NonNullable<ChannelDirectoryAdapter["self"]> = async () =>
  null;

export const emptyChannelDirectoryList: NonNullable<
  ChannelDirectoryAdapter["listPeers"]
> = async () => [];

/** Build a channel directory adapter with a null self resolver by default. */
export function createChannelDirectoryAdapter(
  params: Omit<ChannelDirectoryAdapter, "self"> & {
    self?: ChannelDirectoryAdapter["self"];
  } = {},
): ChannelDirectoryAdapter {
  return {
    self: params.self ?? nullChannelDirectorySelf,
    ...params,
  };
}

/** Build the common empty directory surface for channels without directory support. */
export function createEmptyChannelDirectoryAdapter(): ChannelDirectoryAdapter {
  return createChannelDirectoryAdapter({
    listPeers: emptyChannelDirectoryList,
    listGroups: emptyChannelDirectoryList,
  });
}
