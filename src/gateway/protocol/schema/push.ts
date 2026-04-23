import { Type } from "typebox";
import { NonEmptyString } from "./primitives.js";

const ApnsEnvironmentSchema = Type.String({ enum: ["sandbox", "production"] });

export const PushTestParamsSchema = Type.Object(
  {
    nodeId: NonEmptyString,
    title: Type.Optional(Type.String()),
    body: Type.Optional(Type.String()),
    environment: Type.Optional(ApnsEnvironmentSchema),
  },
  { additionalProperties: false },
);

export const PushTestResultSchema = Type.Object(
  {
    ok: Type.Boolean(),
    status: Type.Integer(),
    apnsId: Type.Optional(Type.String()),
    reason: Type.Optional(Type.String()),
    tokenSuffix: Type.String(),
    topic: Type.String(),
    environment: ApnsEnvironmentSchema,
    transport: Type.String({ enum: ["direct", "relay"] }),
  },
  { additionalProperties: false },
);
