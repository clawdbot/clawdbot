import type { ChatChannelId } from "../ids.js";

/**
 * Channel id accepted by plugin helpers, covering built-in chat ids and external plugin ids.
 */
export type ChannelId = ChatChannelId | (string & {});
