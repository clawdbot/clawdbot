/**
 * Internal channel plugin type barrel.
 *
 * Re-exports curated core-facing channel plugin types without helper-only implementation details.
 */
import type { ChannelMessageActionName as ChannelMessageActionNameFromList } from "./message-action-names.js";

/** Stable message action name union derived from the registered action list. */
export type ChannelMessageActionName = ChannelMessageActionNameFromList;

export type { ChannelMessageActionContext } from "./types.core.js";

export type { ChannelPlugin } from "./types.plugin.js";
