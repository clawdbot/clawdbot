/**
 * Channel plugin id types.
 *
 * Allows built-in chat channel ids and external plugin-provided channel ids.
 */

/**
 * Canonical chat channel id used by core routing, plugin config, and channel catalogs.
 */
export type ChatChannelId = string;

/**
 * Channel id accepted by plugin helpers, covering built-in chat ids and external plugin ids.
 */
export type ChannelId = ChatChannelId | (string & {});
