import type { MoltbotConfig } from "../../config/config.js";
import type { RuntimeEnv } from "../../runtime.js";
import {
  type ChannelId,
  getChannelPlugin,
  listChannelPlugins,
  normalizeChannelId,
} from "./index.js";
import type { ChannelPairingAdapter } from "./types.js";

export function listPairingChannels(): ChannelId[] {
  // Channel docking: pairing support is declared via plugin.pairing.
  return listChannelPlugins()
    .filter((plugin) => plugin.pairing)
    .map((plugin) => plugin.id);
}

export function getPairingAdapter(channelId: ChannelId): ChannelPairingAdapter | null {
  const plugin = getChannelPlugin(channelId);
  return plugin?.pairing ?? null;
}

export function requirePairingAdapter(channelId: ChannelId): ChannelPairingAdapter {
  const adapter = getPairingAdapter(channelId);
  if (!adapter) {
    throw new Error(`Channel ${channelId} does not support pairing`);
  }
  return adapter;
}

export function resolvePairingChannel(raw: unknown): ChannelId {
  const value = (
    typeof raw === "string"
      ? raw
      : typeof raw === "number" || typeof raw === "boolean"
        ? String(raw)
        : ""
  )
    .trim()
    .toLowerCase();
  const normalized = normalizeChannelId(value);
  const channels = listPairingChannels();
  if (!normalized || !channels.includes(normalized)) {
    throw new Error(
      `Invalid channel: ${value || "(empty)"} (expected one of: ${channels.join(", ")})`,
    );
  }
  return normalized;
}

export async function notifyPairingApproved(params: {
  channelId: ChannelId;
  id: string;
  cfg: MoltbotConfig;
  runtime?: RuntimeEnv;
  /** Extension channels can pass their adapter directly to bypass registry lookup. */
  pairingAdapter?: ChannelPairingAdapter;
}): Promise<void> {
  // Extensions may provide adapter directly to bypass ESM module isolation
  const adapter = params.pairingAdapter ?? requirePairingAdapter(params.channelId);
  if (!adapter.notifyApproval) return;
  await adapter.notifyApproval({
    cfg: params.cfg,
    id: params.id,
    runtime: params.runtime,
  });
}
