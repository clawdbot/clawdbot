import { Type } from "@sinclair/typebox";

import { NonEmptyString } from "./primitives.js";

export const WizardStartParamsSchema = Type.Object(
  {
    mode: Type.Optional(
      Type.Union([Type.Literal("local"), Type.Literal("remote")]),
    ),
    workspace: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const WizardAnswerSchema = Type.Object(
  {
    stepId: NonEmptyString,
    value: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

export const WizardNextParamsSchema = Type.Object(
  {
    sessionId: NonEmptyString,
    answer: Type.Optional(WizardAnswerSchema),
  },
  { additionalProperties: false },
);

export const WizardCancelParamsSchema = Type.Object(
  {
    sessionId: NonEmptyString,
  },
  { additionalProperties: false },
);

export const WizardStatusParamsSchema = Type.Object(
  {
    sessionId: NonEmptyString,
  },
  { additionalProperties: false },
);

export const WizardStepOptionSchema = Type.Object(
  {
    value: Type.Unknown(),
    label: NonEmptyString,
    hint: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

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
    options: Type.Optional(Type.Array(WizardStepOptionSchema)),
    initialValue: Type.Optional(Type.Unknown()),
    placeholder: Type.Optional(Type.String()),
    sensitive: Type.Optional(Type.Boolean()),
    executor: Type.Optional(
      Type.Union([Type.Literal("gateway"), Type.Literal("client")]),
    ),
  },
  { additionalProperties: false },
);

export const WizardNextResultSchema = Type.Object(
  {
    done: Type.Boolean(),
    step: Type.Optional(WizardStepSchema),
    status: Type.Optional(
      Type.Union([
        Type.Literal("running"),
        Type.Literal("done"),
        Type.Literal("cancelled"),
        Type.Literal("error"),
      ]),
    ),
    error: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const WizardStartResultSchema = Type.Object(
  {
    sessionId: NonEmptyString,
    done: Type.Boolean(),
    step: Type.Optional(WizardStepSchema),
    status: Type.Optional(
      Type.Union([
        Type.Literal("running"),
        Type.Literal("done"),
        Type.Literal("cancelled"),
        Type.Literal("error"),
      ]),
    ),
    error: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const WizardStatusResultSchema = Type.Object(
  {
    status: Type.Union([
      Type.Literal("running"),
      Type.Literal("done"),
      Type.Literal("cancelled"),
      Type.Literal("error"),
    ]),
    error: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
