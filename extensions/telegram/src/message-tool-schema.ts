// Telegram helper module supports message tool schema behavior.
import { optionalPositiveIntegerSchema } from "openclaw/plugin-sdk/channel-actions";
import { Type } from "typebox";

export function createTelegramPollExtraToolSchemas() {
  return {
    pollDurationSeconds: optionalPositiveIntegerSchema(),
    pollAnonymous: Type.Optional(
      Type.Boolean({
        description:
          "Send a display-only anonymous poll. Anonymous votes do not create agent turns. This is the default unless pollPublic is true.",
      }),
    ),
    pollPublic: Type.Optional(
      Type.Boolean({
        description:
          "Send a public poll whose votes route into the originating agent conversation. Voter identities are visible.",
      }),
    ),
  };
}

/** Schema additions for Telegram reactions through the existing react action. */
export function createTelegramReactionEmojiSchema() {
  return {
    emoji: Type.Optional(
      Type.String({
        description:
          'Telegram reaction emoji: use a supported Unicode reaction, or pass the numeric custom_emoji_id identifier returned by action:"emoji-list" directly as emoji. ' +
          'Use action:"emoji-list" to inspect reactions allowed in the current chat; arbitrary Unicode may be rejected by Telegram.',
      }),
    ),
  };
}

/** Schema additions for Telegram-native rich sends through the existing send action. */
export function createTelegramRichSendExtraToolSchemas() {
  return {
    asVideoNote: Type.Optional(
      Type.Boolean({
        description:
          "Send one video attachment as a round Telegram video note. Captions are delivered separately.",
      }),
    ),
    location: Type.Optional(
      Type.Object(
        {
          latitude: Type.Number({ minimum: -90, maximum: 90 }),
          longitude: Type.Number({ minimum: -180, maximum: 180 }),
          accuracy: Type.Optional(
            Type.Number({
              description: "Pin uncertainty radius in meters.",
              minimum: 0,
              maximum: 1500,
            }),
          ),
          name: Type.Optional(
            Type.String({ description: "Venue name; requires address.", minLength: 1 }),
          ),
          address: Type.Optional(
            Type.String({ description: "Venue address; requires name.", minLength: 1 }),
          ),
        },
        {
          description:
            "Standalone Telegram location. Coordinates send a pin; name plus address sends a venue. Do not combine with message or media.",
        },
      ),
    ),
  };
}
