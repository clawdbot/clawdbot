// Discord plugin module implements send target parsing behavior.
import {
  parseDiscordTarget,
  type DiscordTarget,
  type DiscordTargetParseOptions,
} from "./target-parsing.js";

export type SendDiscordTarget = DiscordTarget;

export const parseDiscordSendTarget = (
  raw: string,
  options: DiscordTargetParseOptions = {},
): SendDiscordTarget | undefined => parseDiscordTarget(raw, options);
