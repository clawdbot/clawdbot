import type {
  DiscordMessagePreflightContext,
  DiscordMessagePreflightParams,
} from "./message-handler.preflight.types.js";

type SharedPreflightFields =
  | "cfg"
  | "discordConfig"
  | "accountId"
  | "token"
  | "runtime"
  | "botUserId"
  | "abortSignal"
  | "guildHistories"
  | "historyLimit"
  | "mediaMaxBytes"
  | "textLimit"
  | "replyToMode"
  | "ackReactionScope"
  | "groupPolicy"
  | "threadBindings"
  | "discordRestFetch";

type BuildDiscordMessagePreflightContextParams = Omit<
  DiscordMessagePreflightContext,
  SharedPreflightFields
> & {
  preflightParams: DiscordMessagePreflightParams;
};

export function buildDiscordMessagePreflightContext({
  preflightParams,
  ...fields
}: BuildDiscordMessagePreflightContextParams): DiscordMessagePreflightContext {
  return {
    cfg: preflightParams.cfg,
    discordConfig: preflightParams.discordConfig,
    accountId: preflightParams.accountId,
    token: preflightParams.token,
    runtime: preflightParams.runtime,
    botUserId: preflightParams.botUserId,
    abortSignal: preflightParams.abortSignal,
    guildHistories: preflightParams.guildHistories,
    historyLimit: preflightParams.historyLimit,
    mediaMaxBytes: preflightParams.mediaMaxBytes,
    textLimit: preflightParams.textLimit,
    replyToMode: preflightParams.replyToMode,
    ackReactionScope: preflightParams.ackReactionScope,
    groupPolicy: preflightParams.groupPolicy,
    ...fields,
    threadBindings: preflightParams.threadBindings,
    discordRestFetch: preflightParams.discordRestFetch,
  };
}
