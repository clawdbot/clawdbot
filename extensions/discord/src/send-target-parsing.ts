import {
  parseDiscordTarget,
  type DiscordTarget,
  type DiscordTargetParseOptions,
} from "./target-parsing.js";

export type SendDiscordTarget = DiscordTarget;

type SendDiscordTargetParseOptions = DiscordTargetParseOptions;

export const parseDiscordSendTarget = (
  raw: string,
  options: SendDiscordTargetParseOptions = {},
): SendDiscordTarget | undefined => parseDiscordTarget(raw, options);
