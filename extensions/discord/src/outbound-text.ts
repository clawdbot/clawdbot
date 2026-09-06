import type { MarkdownTableMode, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import type { ResolvedDiscordAccount } from "./accounts.js";
import { renderDiscordMarkdown } from "./markdown.js";
import { rewriteDiscordKnownMentions } from "./mentions.js";

export function prepareDiscordOutboundText(
  text: string,
  params: {
    cfg: OpenClawConfig;
    account: Pick<ResolvedDiscordAccount, "accountId" | "config">;
    tableMode?: MarkdownTableMode;
  },
) {
  const { account } = params;
  const tableMode =
    params.tableMode ??
    resolveMarkdownTableMode({ cfg: params.cfg, channel: "discord", accountId: account.accountId });
  const renderedText = renderDiscordMarkdown(text, tableMode);
  // Both transports measure chunks after rendering and alias expansion; titles retain display names.
  return {
    renderedText,
    textWithMentions: rewriteDiscordKnownMentions(renderedText, {
      accountId: account.accountId,
      mentionAliases: account.config.mentionAliases,
    }),
  };
}
