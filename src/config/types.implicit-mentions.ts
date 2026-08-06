export type ChannelImplicitMentionsConfig = {
  /** Treat replies to the bot's own message as implicit mentions. */
  replyToBot?: boolean;
  /** Treat quoted bot messages as implicit mentions. */
  quotedBot?: boolean;
  /** Treat follow-ups in threads the bot participated in as implicit mentions. */
  threadParticipation?: boolean;
};
