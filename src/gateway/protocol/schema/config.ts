import { Type } from "typebox";
import { NonEmptyString } from "./primitives.js";

const ConfigSchemaLookupPathString = Type.String({
  minLength: 1,
  maxLength: 1024,
  pattern: "^[A-Za-z0-9_./\\[\\]\\-*]+$",
});

const ConfigDeliveryContextSchema = Type.Object(
  {
    channel: Type.Optional(Type.String()),
    to: Type.Optional(Type.String()),
    accountId: Type.Optional(Type.String()),
    threadId: Type.Optional(Type.Union([Type.String(), Type.Number()])),
  },
  { additionalProperties: false },
);

export const ConfigGetParamsSchema = Type.Object({}, { additionalProperties: false });

export const ConfigSetParamsSchema = Type.Object(
  {
    raw: NonEmptyString,
    baseHash: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

const ConfigApplyLikeParamsSchema = Type.Object(
  {
    raw: NonEmptyString,
    baseHash: Type.Optional(NonEmptyString),
    sessionKey: Type.Optional(Type.String()),
    deliveryContext: Type.Optional(ConfigDeliveryContextSchema),
    note: Type.Optional(Type.String()),
    restartDelayMs: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export const ConfigApplyParamsSchema = ConfigApplyLikeParamsSchema;
export const ConfigPatchParamsSchema = ConfigApplyLikeParamsSchema;

export const ConfigSchemaParamsSchema = Type.Object({}, { additionalProperties: false });

export const ConfigSchemaLookupParamsSchema = Type.Object(
  {
    path: ConfigSchemaLookupPathString,
  },
  { additionalProperties: false },
);

export const UpdateStatusParamsSchema = Type.Object({}, { additionalProperties: false });

export const UpdateRunParamsSchema = Type.Object(
  {
    sessionKey: Type.Optional(Type.String()),
    deliveryContext: Type.Optional(ConfigDeliveryContextSchema),
    note: Type.Optional(Type.String()),
    continuationMessage: Type.Optional(Type.String()),
    restartDelayMs: Type.Optional(Type.Integer({ minimum: 0 })),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

export const ConfigUiHintSchema = Type.Object(
  {
    label: Type.Optional(Type.String()),
    help: Type.Optional(Type.String()),
    tags: Type.Optional(Type.Array(Type.String())),
    group: Type.Optional(Type.String()),
    order: Type.Optional(Type.Integer()),
    advanced: Type.Optional(Type.Boolean()),
    sensitive: Type.Optional(Type.Boolean()),
    placeholder: Type.Optional(Type.String()),
    itemTemplate: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

export const ConfigSchemaResponseSchema = Type.Object(
  {
    schema: Type.Unknown(),
    uiHints: Type.Record(Type.String(), ConfigUiHintSchema),
    version: NonEmptyString,
    generatedAt: NonEmptyString,
  },
  { additionalProperties: false },
);

export const ConfigSchemaLookupChildSchema = Type.Object(
  {
    key: NonEmptyString,
    path: NonEmptyString,
    type: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])),
    required: Type.Boolean(),
    hasChildren: Type.Boolean(),
    hint: Type.Optional(ConfigUiHintSchema),
    hintPath: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const ConfigSchemaLookupResultSchema = Type.Object(
  {
    path: NonEmptyString,
    schema: Type.Unknown(),
    hint: Type.Optional(ConfigUiHintSchema),
    hintPath: Type.Optional(Type.String()),
    children: Type.Array(ConfigSchemaLookupChildSchema),
  },
  { additionalProperties: false },
);
