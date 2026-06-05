/**
 * Public channel plugin type barrel.
 *
 * Re-exports stable plugin-facing channel types and message action names.
 */
import type { ChannelMessageActionName as ChannelMessageActionNameFromList } from "./message-action-names.js";

export { CHANNEL_MESSAGE_ACTION_NAMES } from "./message-action-names.js";
export type * from "./types.core.js";
export type * from "./types.adapters.js";
export type { ChannelMessageCapability } from "./message-capabilities.js";
export type { ChannelPlugin } from "./types.plugin.js";

/** Stable message action name union derived from the registered action list. */
export type ChannelMessageActionName = ChannelMessageActionNameFromList;
