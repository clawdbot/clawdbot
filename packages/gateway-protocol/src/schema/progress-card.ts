import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

export const PROGRESS_CARD_MAX_UTF8_BYTES = 8192;
export const PROGRESS_CARD_MAX_STEPS = 50;
export const PROGRESS_CARD_MAX_STEP_UTF8_BYTES = 512;

export const ProgressCardStepStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("in_progress"),
  Type.Literal("completed"),
]);
export type ProgressCardStepStatus = Static<typeof ProgressCardStepStatusSchema>;

export const ProgressCardStepSchema = closedObject({
  step: Type.String({ minLength: 1 }),
  status: ProgressCardStepStatusSchema,
});
export type ProgressCardStep = Static<typeof ProgressCardStepSchema>;

export const ProgressCardSchema = closedObject({
  sessionKey: NonEmptyString,
  revision: Type.Integer({ minimum: 1 }),
  updatedAt: Type.Integer(),
  markdown: Type.Optional(Type.String()),
  steps: Type.Optional(Type.Array(ProgressCardStepSchema, { maxItems: PROGRESS_CARD_MAX_STEPS })),
});
export type ProgressCard = Static<typeof ProgressCardSchema>;

export const ProgressCardGetParamsSchema = closedObject({
  sessionKey: NonEmptyString,
  agentId: Type.Optional(NonEmptyString),
});
export type ProgressCardGetParams = Static<typeof ProgressCardGetParamsSchema>;

export const ProgressCardGetResultSchema = closedObject({
  card: Type.Union([ProgressCardSchema, Type.Null()]),
});
export type ProgressCardGetResult = Static<typeof ProgressCardGetResultSchema>;

export const ProgressCardPutParamsSchema = closedObject({
  sessionKey: NonEmptyString,
  agentId: Type.Optional(NonEmptyString),
  markdown: Type.Optional(Type.String()),
  plan: Type.Optional(Type.Array(ProgressCardStepSchema, { maxItems: PROGRESS_CARD_MAX_STEPS })),
  expectedRevision: Type.Optional(Type.Integer({ minimum: 1 })),
});
export type ProgressCardPutParams = Static<typeof ProgressCardPutParamsSchema>;

export const ProgressCardPutResultSchema = ProgressCardGetResultSchema;
export type ProgressCardPutResult = Static<typeof ProgressCardPutResultSchema>;

export const ProgressCardChangedEventSchema = closedObject({
  sessionKey: NonEmptyString,
  revision: Type.Union([Type.Number(), Type.Null()]),
});
export type ProgressCardChangedEvent = Static<typeof ProgressCardChangedEventSchema>;
