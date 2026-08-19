// Channel hub presentation: bundled art reuse plus typed per-channel setup
// helper links surfaced in the setup wizard. Labels/order still come from the
// gateway channels.status snapshot; this table only decorates known channels.
type ChannelSetupLink = {
  label: string;
  url: string;
};

type ChannelHubMeta = {
  /** External helper destinations shown while the setup wizard is open. */
  setupLinks?: ChannelSetupLink[];
};

/** Static helper links: these are the services' own consoles, not config. */
export function channelHubMeta(channelId: string): ChannelHubMeta {
  switch (channelId) {
    case "telegram":
      return {
        setupLinks: [
          { label: "@BotFather", url: "https://t.me/BotFather" },
          { label: "web.telegram.org", url: "https://web.telegram.org" },
        ],
      };
    case "discord":
      return {
        setupLinks: [
          { label: "Developer Portal", url: "https://discord.com/developers/applications" },
        ],
      };
    case "slack":
      return {
        setupLinks: [{ label: "api.slack.com/apps", url: "https://api.slack.com/apps" }],
      };
    case "signal":
      return {
        setupLinks: [{ label: "signal-cli", url: "https://github.com/AsamK/signal-cli" }],
      };
    default:
      return {};
  }
}

export function channelDocsUrl(channelId: string): string {
  return `https://docs.openclaw.ai/channels/${encodeURIComponent(channelId)}`;
}
