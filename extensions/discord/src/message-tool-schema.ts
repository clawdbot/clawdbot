import { Type } from "@sinclair/typebox";
import { stringEnum } from "openclaw/plugin-sdk/channel-actions";

const discordComponentEmojiSchema = Type.Object({
  name: Type.String(),
  id: Type.Optional(Type.String()),
  animated: Type.Optional(Type.Boolean()),
});

const discordComponentOptionSchema = Type.Object({
  label: Type.String(),
  value: Type.String(),
  description: Type.Optional(Type.String()),
  emoji: Type.Optional(discordComponentEmojiSchema),
  default: Type.Optional(Type.Boolean()),
});

const discordComponentButtonSchema = Type.Object({
  label: Type.String(),
  style: Type.Optional(stringEnum(["primary", "secondary", "success", "danger", "link"])),
  url: Type.Optional(Type.String()),
  emoji: Type.Optional(discordComponentEmojiSchema),
  disabled: Type.Optional(Type.Boolean()),
  allowedUsers: Type.Optional(
    Type.Array(
      Type.String({
        description: "Discord user ids or names allowed to interact with this button.",
      }),
    ),
  ),
});

const discordComponentSelectSchema = Type.Object({
  type: Type.Optional(stringEnum(["string", "user", "role", "mentionable", "channel"])),
  placeholder: Type.Optional(Type.String()),
  minValues: Type.Optional(Type.Number()),
  maxValues: Type.Optional(Type.Number()),
  options: Type.Optional(Type.Array(discordComponentOptionSchema)),
});

const discordComponentBlockSchema = Type.Object({
  type: Type.String(),
  text: Type.Optional(Type.String()),
  texts: Type.Optional(Type.Array(Type.String())),
  accessory: Type.Optional(
    Type.Object({
      type: Type.String(),
      url: Type.Optional(Type.String()),
      button: Type.Optional(discordComponentButtonSchema),
    }),
  ),
  spacing: Type.Optional(stringEnum(["small", "large"])),
  divider: Type.Optional(Type.Boolean()),
  buttons: Type.Optional(Type.Array(discordComponentButtonSchema)),
  select: Type.Optional(discordComponentSelectSchema),
  items: Type.Optional(
    Type.Array(
      Type.Object({
        url: Type.String(),
        description: Type.Optional(Type.String()),
        spoiler: Type.Optional(Type.Boolean()),
      }),
    ),
  ),
  file: Type.Optional(Type.String()),
  spoiler: Type.Optional(Type.Boolean()),
});

const discordComponentModalFieldSchema = Type.Object({
  type: Type.String(),
  name: Type.Optional(Type.String()),
  label: Type.String(),
  description: Type.Optional(Type.String()),
  placeholder: Type.Optional(Type.String()),
  required: Type.Optional(Type.Boolean()),
  options: Type.Optional(Type.Array(discordComponentOptionSchema)),
  minValues: Type.Optional(Type.Number()),
  maxValues: Type.Optional(Type.Number()),
  minLength: Type.Optional(Type.Number()),
  maxLength: Type.Optional(Type.Number()),
  style: Type.Optional(stringEnum(["short", "paragraph"])),
});

const discordComponentModalSchema = Type.Object({
  title: Type.String(),
  triggerLabel: Type.Optional(Type.String()),
  triggerStyle: Type.Optional(stringEnum(["primary", "secondary", "success", "danger", "link"])),
  fields: Type.Array(discordComponentModalFieldSchema),
});

export function createDiscordMessageToolComponentsSchema() {
  return Type.Object(
    {
      text: Type.Optional(Type.String()),
      reusable: Type.Optional(
        Type.Boolean({
          description: "Allow components to be used multiple times until they expire.",
        }),
      ),
      container: Type.Optional(
        Type.Object({
          accentColor: Type.Optional(Type.String()),
          spoiler: Type.Optional(Type.Boolean()),
        }),
      ),
      blocks: Type.Optional(Type.Array(discordComponentBlockSchema)),
      modal: Type.Optional(discordComponentModalSchema),
    },
    {
      description:
        "Discord components v2 payload. Set reusable=true to keep buttons, selects, and forms active until expiry.",
    },
  );
}
