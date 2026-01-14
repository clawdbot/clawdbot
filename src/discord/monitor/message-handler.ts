import type { HistoryEntry } from "../../auto-reply/reply/history.js";
import type { ReplyToMode } from "../../config/config.js";
import { danger } from "../../globals.js";
import type { RuntimeEnv } from "../../runtime.js";
import type { DiscordGuildEntryResolved } from "./allow-list.js";
import type { DiscordMessageHandler } from "./listeners.js";
import { preflightDiscordMessage } from "./message-handler.preflight.js";
import { processDiscordMessage } from "./message-handler.process.js";

type LoadedConfig = ReturnType<
  typeof import("../../config/config.js").loadConfig
>;
type DiscordConfig = NonNullable<
  import("../../config/config.js").ClawdbotConfig["channels"]
>["discord"];

export function createDiscordMessageHandler(params: {
  cfg: LoadedConfig;
  discordConfig: DiscordConfig;
  accountId: string;
  token: string;
  runtime: RuntimeEnv;
  botUserId?: string;
  guildHistories: Map<string, HistoryEntry[]>;
  historyLimit: number;
  mediaMaxBytes: number;
  textLimit: number;
  replyToMode: ReplyToMode;
  dmEnabled: boolean;
  groupDmEnabled: boolean;
  groupDmChannels?: Array<string | number>;
  allowFrom?: Array<string | number>;
  guildEntries?: Record<string, DiscordGuildEntryResolved>;
}): DiscordMessageHandler {
  const groupPolicy = params.discordConfig?.groupPolicy ?? "open";
  const ackReactionScope =
    params.cfg.messages?.ackReactionScope ?? "group-mentions";

  return async (data, client) => {
    try {
      const ctx = await preflightDiscordMessage({
        ...params,
        ackReactionScope,
        groupPolicy,
        data,
        client,
      });
      if (!ctx) return;
      await processDiscordMessage(ctx);
    } catch (err) {
      params.runtime.error?.(danger(`handler failed: ${String(err)}`));
    }
  };
}
