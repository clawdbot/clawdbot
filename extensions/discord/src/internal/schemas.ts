import { Type } from "typebox";
import { Check } from "typebox/value";

const discordInteractionPayloadSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    token: Type.String({ minLength: 1 }),
    type: Type.Number(),
  },
  { additionalProperties: true },
);

const discordRateLimitBodySchema = Type.Object(
  {
    message: Type.Optional(Type.String()),
    retry_after: Type.Optional(Type.Union([Type.Number(), Type.String()])),
    global: Type.Optional(Type.Boolean()),
    code: Type.Optional(Type.Union([Type.Number(), Type.String()])),
  },
  { additionalProperties: true },
);

export function assertDiscordInteractionPayload(value: unknown): void {
  if (!Check(discordInteractionPayloadSchema, value)) {
    throw new Error("Invalid Discord interaction payload");
  }
}

export function isDiscordRateLimitBody(value: unknown): value is {
  message?: string;
  retry_after?: number | string;
  global?: boolean;
  code?: number | string;
} {
  return Check(discordRateLimitBodySchema, value);
}
