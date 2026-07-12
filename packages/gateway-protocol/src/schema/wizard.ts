// Gateway Protocol schema module defines protocol validation shapes.
import type { Static } from "typebox";
import { Type } from "typebox";
import { NonEmptyString } from "./primitives.js";

/** Runtime state reported for gateway-driven setup wizard sessions. */
const WizardRunStatusSchema = Type.Union([
  Type.Literal("running"),
  Type.Literal("done"),
  Type.Literal("cancelled"),
  Type.Literal("error"),
]);

/** Starts a setup wizard, optionally scoped to a local or remote workspace. */
export const WizardStartParamsSchema = Type.Object(
  {
    mode: Type.Optional(Type.Union([Type.Literal("local"), Type.Literal("remote")])),
    workspace: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** Client answer payload for the current wizard step. */
export const WizardAnswerSchema = Type.Object(
  {
    stepId: NonEmptyString,
    value: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

/** Advances a wizard session, with an answer when the previous step requested input. */
export const WizardNextParamsSchema = Type.Object(
  {
    sessionId: NonEmptyString,
    answer: Type.Optional(WizardAnswerSchema),
  },
  { additionalProperties: false },
);

/** Shared session-id-only params for cancel and status requests. */
const WizardSessionIdParamsSchema = Type.Object(
  {
    sessionId: NonEmptyString,
  },
  { additionalProperties: false },
);

/** Cancels an active wizard session. */
export const WizardCancelParamsSchema = WizardSessionIdParamsSchema;

/** Reads status for an active or recently completed wizard session. */
export const WizardStatusParamsSchema = WizardSessionIdParamsSchema;

/** Selectable value shown in a choice-based wizard step. */
export const WizardStepOptionSchema = Type.Object(
  {
    value: Type.Unknown(),
    label: NonEmptyString,
    hint: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const WizardDeviceCodeSchema = Type.Object(
  {
    code: NonEmptyString,
    expiresInMinutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 1440 })),
    message: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** UI contract for one wizard step rendered by gateway clients. */
export const WizardStepSchema = Type.Object(
  {
    id: NonEmptyString,
    type: Type.Union([
      Type.Literal("note"),
      Type.Literal("select"),
      Type.Literal("text"),
      Type.Literal("confirm"),
      Type.Literal("multiselect"),
      Type.Literal("progress"),
      Type.Literal("action"),
    ]),
    title: Type.Optional(Type.String()),
    message: Type.Optional(Type.String()),
    format: Type.Optional(Type.Union([Type.Literal("plain")])),
    options: Type.Optional(Type.Array(WizardStepOptionSchema)),
    initialValue: Type.Optional(Type.Unknown()),
    placeholder: Type.Optional(Type.String()),
    sensitive: Type.Optional(Type.Boolean()),
    executor: Type.Optional(Type.Union([Type.Literal("gateway"), Type.Literal("client")])),
    externalUrl: Type.Optional(Type.String()),
    deviceCode: Type.Optional(WizardDeviceCodeSchema),
  },
  { additionalProperties: false },
);

/** Common response fields for start and next calls. */
const WizardResultFields = {
  done: Type.Boolean(),
  step: Type.Optional(WizardStepSchema),
  status: Type.Optional(WizardRunStatusSchema),
  error: Type.Optional(Type.String()),
};

/** Result after advancing a wizard session. */
export const WizardNextResultSchema = Type.Object(WizardResultFields, {
  additionalProperties: false,
});

/** Result returned when a wizard session is created. */
export const WizardStartResultSchema = Type.Object(
  {
    sessionId: NonEmptyString,
    ...WizardResultFields,
  },
  { additionalProperties: false },
);

/** Minimal status poll result used when the client does not need the next step. */
export const WizardStatusResultSchema = Type.Object(
  {
    status: WizardRunStatusSchema,
    error: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

// Wire types derive directly from local schema consts so public d.ts graphs never
// pull in the ProtocolSchemas registry.
export type WizardStartParams = Static<typeof WizardStartParamsSchema>;
export type WizardNextParams = Static<typeof WizardNextParamsSchema>;
export type WizardCancelParams = Static<typeof WizardCancelParamsSchema>;
export type WizardStatusParams = Static<typeof WizardStatusParamsSchema>;
export type WizardStep = Static<typeof WizardStepSchema>;
export type WizardNextResult = Static<typeof WizardNextResultSchema>;
export type WizardStartResult = Static<typeof WizardStartResultSchema>;
export type WizardStatusResult = Static<typeof WizardStatusResultSchema>;
