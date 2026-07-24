import { Type, type Static } from "typebox";
import { NonEmptyString } from "./primitives.js";

export const AiExecuteParamsSchema = Type.Object(
  {
    componentId: NonEmptyString,
    prompt: NonEmptyString,
    requestId: Type.Optional(NonEmptyString),
    systemPrompt: Type.Optional(NonEmptyString),
    timeoutSeconds: Type.Optional(Type.Number({ minimum: 0.1, maximum: 300 })),
  },
  { additionalProperties: false },
);

export const AiExecutionAttemptSchema = Type.Object(
  {
    providerName: NonEmptyString,
    modelId: NonEmptyString,
    status: Type.Union([
      Type.Literal("success"),
      Type.Literal("timeout"),
      Type.Literal("unavailable"),
      Type.Literal("invalid-response"),
      Type.Literal("provider-error"),
    ]),
    startedAt: NonEmptyString,
    finishedAt: NonEmptyString,
    durationMs: Type.Integer({ minimum: 0 }),
    errorType: Type.Union([Type.String(), Type.Null()]),
    errorMessage: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);

export const AiExecuteResultSchema = Type.Object(
  {
    requestId: NonEmptyString,
    componentId: NonEmptyString,
    status: Type.Union([Type.Literal("success"), Type.Literal("failed")]),
    content: Type.Union([Type.String(), Type.Null()]),
    selectedModelId: Type.Union([Type.String(), Type.Null()]),
    attempts: Type.Array(AiExecutionAttemptSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);

export type AiExecuteParams = Static<typeof AiExecuteParamsSchema>;
export type AiExecuteResult = Static<typeof AiExecuteResultSchema>;
