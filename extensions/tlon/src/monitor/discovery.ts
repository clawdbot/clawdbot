import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import type { Foreigns } from "../urbit/foreigns.js";
import { asRecord, formatErrorMessage } from "./utils.js";

interface InitData {
  channels: string[];
  foreigns: Foreigns | null;
}

/**
 * Fetch groups-ui init data, returning channels and foreigns.
 * This is a single scry that provides both channel discovery and pending invites.
 */
export async function fetchInitData(
  api: { scry: (path: string) => Promise<unknown> },
  runtime: RuntimeEnv,
): Promise<InitData> {
  try {
    runtime.log?.("[tlon] Fetching groups-ui init data...");
    const initData = asRecord(await api.scry("/groups-ui/v6/init.json"));

    const channels: string[] = [];
    const groups = asRecord(initData?.groups);
    if (groups) {
      for (const groupData of Object.values(groups)) {
        const typedGroupData = asRecord(groupData);
        const groupChannels = asRecord(typedGroupData?.channels);
        if (groupChannels) {
          for (const channelNest of Object.keys(groupChannels)) {
            if (channelNest.startsWith("chat/")) {
              channels.push(channelNest);
            }
          }
        }
      }
    }

    if (channels.length > 0) {
      runtime.log?.(`[tlon] Auto-discovered ${channels.length} chat channel(s)`);
    } else {
      runtime.log?.("[tlon] No chat channels found via auto-discovery");
    }

    const foreignsValue = asRecord(initData?.foreigns);
    const foreigns = foreignsValue ? (foreignsValue as Foreigns) : null;
    if (foreigns) {
      const pendingCount = Object.values(foreigns).filter((f) =>
        f.invites?.some((i) => i.valid),
      ).length;
      if (pendingCount > 0) {
        runtime.log?.(`[tlon] Found ${pendingCount} pending group invite(s)`);
      }
    }

    return { channels, foreigns };
  } catch (error: unknown) {
    runtime.log?.(`[tlon] Init data fetch failed: ${formatErrorMessage(error)}`);
    return { channels: [], foreigns: null };
  }
}

export async function fetchAllChannels(
  api: { scry: (path: string) => Promise<unknown> },
  runtime: RuntimeEnv,
): Promise<string[]> {
  const { channels } = await fetchInitData(api, runtime);
  return channels;
}
