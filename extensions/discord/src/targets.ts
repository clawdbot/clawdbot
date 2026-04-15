import {
  parseDiscordTarget,
  type DiscordTarget,
  type DiscordTargetKind,
  type DiscordTargetParseOptions,
  resolveDiscordChannelId,
} from "./target-parsing.js";
import { resolveDiscordTarget } from "./target-resolver.js";

export { parseDiscordTarget, resolveDiscordChannelId };
export type { DiscordTarget, DiscordTargetKind, DiscordTargetParseOptions };
export { resolveDiscordTarget };
