export type DiscordChannelAudienceAccessGroup = {
  /**
   * Discord dynamic audience backed by the users who can currently view a guild
   * channel.
   */
  type: "discord.channelAudience";
  /** Guild ID that owns the channel. */
  guildId: string;
  /** Channel ID whose effective ViewChannel permission defines the audience. */
  channelId: string;
  /** Audience predicate. Defaults to canViewChannel. */
  membership?: "canViewChannel";
};

export type MessageSendersAccessGroup = {
  /**
   * Static sender allowlists that can be referenced by any message channel via
   * accessGroup:<name>.
   */
  type: "message.senders";
  /** Sender entries by channel id, plus optional "*" entries shared by all channels. */
  members: Record<string, string[]>;
};

export type AccessGroupConfig = DiscordChannelAudienceAccessGroup | MessageSendersAccessGroup;

export type AccessGroupsConfig = Record<string, AccessGroupConfig>;
