// Telegram helper module supports message tool schema behavior.
import { optionalPositiveIntegerSchema } from "openclaw/plugin-sdk/channel-actions";
import { Type } from "typebox";

export function createTelegramPollExtraToolSchemas() {
  return {
    pollDurationSeconds: optionalPositiveIntegerSchema(),
    pollAnonymous: Type.Optional(Type.Boolean()),
    pollPublic: Type.Optional(Type.Boolean()),
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
