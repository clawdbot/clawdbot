/**
 * Channel conversation binding lifecycle helpers.
 *
 * Starts plugin binding managers and updates per-session binding idle/max-age limits.
 */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getChannelPlugin } from "./registry.js";
import type { ChannelId } from "./types.public.js";

/**
 * Starts the optional per-channel conversation binding manager.
 *
 * Channels without binding state return `null` so callers can install
 * lifecycle hooks without special-casing plugins that do not support them.
 */
export async function createChannelConversationBindingManager(params: {
  channelId: ChannelId;
  cfg: OpenClawConfig;
  accountId?: string | null;
}): Promise<{ stop: () => void | Promise<void> } | null> {
  const createManager = getChannelPlugin(params.channelId)?.conversationBindings?.createManager;
  if (!createManager) {
    return null;
  }
  return await createManager({
    cfg: params.cfg,
    accountId: params.accountId,
  });
}

/**
 * Updates the idle timeout for bindings that match a session key.
 *
 * Missing plugin support is a no-op because session commands fan out through
 * generic channel helpers while only some channels keep conversation bindings.
 */
export function setChannelConversationBindingIdleTimeoutBySessionKey(params: {
  channelId: ChannelId;
  targetSessionKey: string;
  accountId?: string | null;
  idleTimeoutMs: number;
}): Array<{
  boundAt: number;
  lastActivityAt: number;
  idleTimeoutMs?: number;
  maxAgeMs?: number;
}> {
  const setIdleTimeoutBySessionKey = getChannelPlugin(params.channelId)?.conversationBindings
    ?.setIdleTimeoutBySessionKey;
  if (!setIdleTimeoutBySessionKey) {
    return [];
  }
  return setIdleTimeoutBySessionKey({
    targetSessionKey: params.targetSessionKey,
    accountId: params.accountId,
    idleTimeoutMs: params.idleTimeoutMs,
  });
}

/**
 * Updates the max age for bindings that match a session key.
 *
 * Returns the modified binding snapshots so command handlers can report the
 * concrete sessions affected by the generic channel command.
 */
export function setChannelConversationBindingMaxAgeBySessionKey(params: {
  channelId: ChannelId;
  targetSessionKey: string;
  accountId?: string | null;
  maxAgeMs: number;
}): Array<{
  boundAt: number;
  lastActivityAt: number;
  idleTimeoutMs?: number;
  maxAgeMs?: number;
}> {
  const setMaxAgeBySessionKey = getChannelPlugin(params.channelId)?.conversationBindings
    ?.setMaxAgeBySessionKey;
  if (!setMaxAgeBySessionKey) {
    return [];
  }
  return setMaxAgeBySessionKey({
    targetSessionKey: params.targetSessionKey,
    accountId: params.accountId,
    maxAgeMs: params.maxAgeMs,
  });
}
