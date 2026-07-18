// Gateway Protocol schema module defines transient operator questions.
import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

const QuestionIdSchema = Type.String({ pattern: "^[a-z][a-z0-9_]*$" });
const QuestionHeaderSchema = Type.String({ maxLength: 12 });

export const QuestionOptionSchema = closedObject({
  label: NonEmptyString,
  description: Type.Optional(Type.String()),
});

const QuestionInputFields = {
  id: QuestionIdSchema,
  header: Type.String(),
  question: NonEmptyString,
  options: Type.Array(QuestionOptionSchema, { maxItems: 4 }),
  multiSelect: Type.Optional(Type.Boolean()),
  isOther: Type.Optional(Type.Boolean()),
  isSecret: Type.Optional(Type.Boolean()),
};

/** Unnormalized question accepted by question.request. */
export const QuestionRequestQuestionSchema = closedObject(QuestionInputFields);

const QuestionFields = {
  ...QuestionInputFields,
  header: QuestionHeaderSchema,
};

/** Canonical normalized question shown to an operator. */
export const QuestionSchema = closedObject(QuestionFields);

export const QuestionAnswersSchema = closedObject({
  answers: Type.Record(QuestionIdSchema, closedObject({ answers: Type.Array(Type.String()) })),
});

export const QuestionStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("answered"),
  Type.Literal("cancelled"),
  Type.Literal("expired"),
]);

/**
 * One pending or recently resolved transient question request. Flat object with
 * optional terminal fields (exec-approval record precedent): native protocol
 * codegen cannot emit per-status object unions, and the manager owns the
 * status/answers invariant (answers present only when status is "answered").
 */
export const QuestionRecordSchema = closedObject({
  id: NonEmptyString,
  questions: Type.Array(QuestionSchema, { minItems: 1, maxItems: 3 }),
  agentId: Type.Optional(NonEmptyString),
  sessionKey: Type.Optional(NonEmptyString),
  createdAtMs: Type.Integer({ minimum: 0 }),
  expiresAtMs: Type.Integer({ minimum: 0 }),
  status: QuestionStatusSchema,
  answers: Type.Optional(QuestionAnswersSchema),
  resolvedBy: Type.Optional(NonEmptyString),
});

export const QuestionRequestParamsSchema = closedObject({
  id: Type.Optional(NonEmptyString),
  questions: Type.Array(QuestionRequestQuestionSchema, { minItems: 1, maxItems: 3 }),
  agentId: Type.Optional(NonEmptyString),
  sessionKey: Type.Optional(NonEmptyString),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
});

export const QuestionRequestResultSchema = closedObject({
  id: NonEmptyString,
  expiresAtMs: Type.Integer({ minimum: 0 }),
});

export const QuestionWaitAnswerParamsSchema = closedObject({
  id: NonEmptyString,
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
});

export const QuestionWaitAnswerResultSchema = Type.Union([
  closedObject({ status: Type.Literal("pending") }),
  closedObject({ status: Type.Literal("answered"), answers: QuestionAnswersSchema }),
  closedObject({ status: Type.Literal("cancelled") }),
  closedObject({ status: Type.Literal("expired") }),
]);

export const QuestionResolveParamsSchema = Type.Union([
  closedObject({
    id: NonEmptyString,
    answers: QuestionAnswersSchema,
    resolvedBy: Type.Optional(NonEmptyString),
  }),
  closedObject({
    id: NonEmptyString,
    cancel: Type.Literal(true),
    resolvedBy: Type.Optional(NonEmptyString),
  }),
]);

export const QuestionResolveResultSchema = Type.Union([
  closedObject({ status: Type.Literal("answered"), answers: QuestionAnswersSchema }),
  closedObject({ status: Type.Literal("cancelled") }),
]);

export const QuestionGetParamsSchema = closedObject({ id: NonEmptyString });
export const QuestionGetResultSchema = closedObject({ question: QuestionRecordSchema });
export const QuestionListParamsSchema = closedObject({});
export const QuestionListResultSchema = closedObject({
  questions: Type.Array(QuestionRecordSchema),
});

export const QuestionRequestedEventSchema = QuestionRecordSchema;
export const QuestionResolvedEventSchema = Type.Union([
  closedObject({
    id: NonEmptyString,
    status: Type.Literal("answered"),
    answers: QuestionAnswersSchema,
  }),
  closedObject({ id: NonEmptyString, status: Type.Literal("cancelled") }),
  closedObject({ id: NonEmptyString, status: Type.Literal("expired") }),
]);

export type QuestionOption = Static<typeof QuestionOptionSchema>;
export type Question = Static<typeof QuestionSchema>;
export type QuestionRequestQuestion = Static<typeof QuestionRequestQuestionSchema>;
export type QuestionAnswers = Static<typeof QuestionAnswersSchema>;
export type QuestionStatus = Static<typeof QuestionStatusSchema>;
export type QuestionRecord = Static<typeof QuestionRecordSchema>;
export type QuestionRequestParams = Static<typeof QuestionRequestParamsSchema>;
export type QuestionRequestResult = Static<typeof QuestionRequestResultSchema>;
export type QuestionWaitAnswerParams = Static<typeof QuestionWaitAnswerParamsSchema>;
export type QuestionWaitAnswerResult = Static<typeof QuestionWaitAnswerResultSchema>;
export type QuestionResolveParams = Static<typeof QuestionResolveParamsSchema>;
export type QuestionResolveResult = Static<typeof QuestionResolveResultSchema>;
export type QuestionGetParams = Static<typeof QuestionGetParamsSchema>;
export type QuestionGetResult = Static<typeof QuestionGetResultSchema>;
export type QuestionListParams = Static<typeof QuestionListParamsSchema>;
export type QuestionListResult = Static<typeof QuestionListResultSchema>;
export type QuestionRequestedEvent = Static<typeof QuestionRequestedEventSchema>;
export type QuestionResolvedEvent = Static<typeof QuestionResolvedEventSchema>;
