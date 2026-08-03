/**
 * Channel plugin id types.
 *
 * Allows built-in chat channel ids and external plugin-provided channel ids.
 */
import type { ChatChannelId } from "../ids.js";

/**
 * Channel id accepted by plugin helpers, covering built-in chat ids and external plugin ids.
 */
export type ChannelId = ChatChannelId | (string & {});
