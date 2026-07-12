// Gateway Protocol schema module defines protocol validation shapes.
import type { Static } from "typebox";
import { Type } from "typebox";
import { NonEmptyString } from "./primitives.js";

/**
 * Gateway config and update protocol schemas.
 *
 * These payloads carry raw config text plus optional delivery context so the
 * gateway can report edits/restarts back to the originating channel.
 */
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

/** Empty request payload for reading the current raw config. */
export const ConfigGetParamsSchema = Type.Object({}, { additionalProperties: false });

/** Full raw config replacement request with optional base hash guard. */
export const ConfigSetParamsSchema = Type.Object(
  {
    raw: NonEmptyString,
    baseHash: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

/** Shared config apply/patch payload with optional restart notification context. */
const ConfigApplyLikeParamProperties = {
  raw: NonEmptyString,
  baseHash: Type.Optional(NonEmptyString),
  sessionKey: Type.Optional(Type.String()),
  deliveryContext: Type.Optional(ConfigDeliveryContextSchema),
  note: Type.Optional(Type.String()),
  restartDelayMs: Type.Optional(Type.Integer({ minimum: 0 })),
} as const;

const ConfigApplyLikeParamsSchema = Type.Object(ConfigApplyLikeParamProperties, {
  additionalProperties: false,
});

/** Raw config apply request that may schedule a restart. */
export const ConfigApplyParamsSchema = ConfigApplyLikeParamsSchema;
/** Raw config patch request that may schedule a restart. */
export const ConfigPatchParamsSchema = Type.Object(
  {
    ...ConfigApplyLikeParamProperties,
    replacePaths: Type.Optional(Type.Array(NonEmptyString, { maxItems: 256 })),
  },
  { additionalProperties: false },
);

/** Empty request payload for fetching the generated config schema. */
export const ConfigSchemaParamsSchema = Type.Object({}, { additionalProperties: false });

/** Schema lookup request for one config path. */
export const ConfigSchemaLookupParamsSchema = Type.Object(
  {
    path: ConfigSchemaLookupPathString,
  },
  { additionalProperties: false },
);

/** Empty request payload for checking update/restart status. */
export const UpdateStatusParamsSchema = Type.Object({}, { additionalProperties: false });

/** Request payload for running an update/restart flow with optional channel delivery context. */
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

/** UI metadata attached to config schema paths. */
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

/** Full generated config schema response. */
export const ConfigSchemaResponseSchema = Type.Object(
  {
    schema: Type.Unknown(),
    uiHints: Type.Record(Type.String(), ConfigUiHintSchema),
    version: NonEmptyString,
    generatedAt: NonEmptyString,
  },
  { additionalProperties: false },
);

/** Child entry returned when looking up a config schema path. */
export const ConfigSchemaLookupChildSchema = Type.Object(
  {
    key: NonEmptyString,
    path: NonEmptyString,
    type: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])),
    required: Type.Boolean(),
    hasChildren: Type.Boolean(),
    reloadKind: Type.Optional(
      Type.Union([Type.Literal("restart"), Type.Literal("hot"), Type.Literal("none")]),
    ),
    hint: Type.Optional(ConfigUiHintSchema),
    hintPath: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** Schema lookup response for one config path and its immediate children. */
export const ConfigSchemaLookupResultSchema = Type.Object(
  {
    path: NonEmptyString,
    schema: Type.Unknown(),
    reloadKind: Type.Optional(
      Type.Union([Type.Literal("restart"), Type.Literal("hot"), Type.Literal("none")]),
    ),
    hint: Type.Optional(ConfigUiHintSchema),
    hintPath: Type.Optional(Type.String()),
    children: Type.Array(ConfigSchemaLookupChildSchema),
  },
  { additionalProperties: false },
);

// Wire types derive directly from local schema consts so public d.ts graphs never
// pull in the ProtocolSchemas registry.
export type ConfigGetParams = Static<typeof ConfigGetParamsSchema>;
export type ConfigSetParams = Static<typeof ConfigSetParamsSchema>;
export type ConfigApplyParams = Static<typeof ConfigApplyParamsSchema>;
export type ConfigPatchParams = Static<typeof ConfigPatchParamsSchema>;
export type ConfigSchemaParams = Static<typeof ConfigSchemaParamsSchema>;
export type ConfigSchemaLookupParams = Static<typeof ConfigSchemaLookupParamsSchema>;
export type ConfigSchemaResponse = Static<typeof ConfigSchemaResponseSchema>;
export type ConfigSchemaLookupResult = Static<typeof ConfigSchemaLookupResultSchema>;
export type UpdateStatusParams = Static<typeof UpdateStatusParamsSchema>;
export type UpdateRunParams = Static<typeof UpdateRunParamsSchema>;
