import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { Type } from "typebox";
import type { QuestionRequestQuestion } from "../../../packages/gateway-protocol/src/index.js";
import { ToolInputError } from "./common.js";

export const DEFAULT_ASK_USER_TIMEOUT_SECONDS = 900;
const MIN_ASK_USER_TIMEOUT_SECONDS = 30;
const MAX_ASK_USER_TIMEOUT_SECONDS = 3600;
const QUESTION_ID_PATTERN = /^[a-z][a-z0-9_]*$/;

export type NormalizedAskUserParams = {
  questions: QuestionRequestQuestion[];
  timeoutSeconds: number;
};

function readRequiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ToolInputError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeOption(value: unknown, questionIndex: number, optionIndex: number) {
  const labelPrefix = `questions[${questionIndex}].options[${optionIndex}]`;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ToolInputError(`${labelPrefix} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const label = readRequiredString(record.label, `${labelPrefix}.label`);
  if (label.length > 64) {
    throw new ToolInputError(`${labelPrefix}.label must be at most 64 characters (use 1-5 words)`);
  }
  if (record.description !== undefined && typeof record.description !== "string") {
    throw new ToolInputError(`${labelPrefix}.description must be a string`);
  }
  const description =
    typeof record.description === "string" ? record.description.trim() : undefined;
  return { label, ...(description ? { description } : {}) };
}

/** Validates and canonicalizes model-authored ask_user arguments. */
export function normalizeAskUserParams(value: unknown): NormalizedAskUserParams {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ToolInputError("ask_user arguments must be an object");
  }
  const params = value as Record<string, unknown>;
  if (
    !Array.isArray(params.questions) ||
    params.questions.length < 1 ||
    params.questions.length > 3
  ) {
    throw new ToolInputError("questions must contain 1 to 3 questions");
  }
  const ids = new Set<string>();
  const questions = params.questions.map(
    (questionValue, questionIndex): QuestionRequestQuestion => {
      const prefix = `questions[${questionIndex}]`;
      if (!questionValue || typeof questionValue !== "object" || Array.isArray(questionValue)) {
        throw new ToolInputError(`${prefix} must be an object`);
      }
      const question = questionValue as Record<string, unknown>;
      const id = readRequiredString(question.id, `${prefix}.id`);
      if (!QUESTION_ID_PATTERN.test(id)) {
        throw new ToolInputError(`${prefix}.id must be snake_case (for example, deploy_target)`);
      }
      if (ids.has(id)) {
        throw new ToolInputError(`duplicate question id '${id}'`);
      }
      ids.add(id);
      const header = truncateUtf16Safe(readRequiredString(question.header, `${prefix}.header`), 12);
      const questionText = readRequiredString(question.question, `${prefix}.question`);
      if (
        !Array.isArray(question.options) ||
        question.options.length < 2 ||
        question.options.length > 4
      ) {
        throw new ToolInputError(`${prefix}.options must contain 2 to 4 options`);
      }
      if (question.multiSelect !== undefined && typeof question.multiSelect !== "boolean") {
        throw new ToolInputError(`${prefix}.multiSelect must be a boolean`);
      }
      return {
        questionId: id,
        header,
        question: questionText,
        options: question.options.map((option, optionIndex) =>
          normalizeOption(option, questionIndex, optionIndex),
        ),
        ...(question.multiSelect === true ? { multiSelect: true } : {}),
        isOther: true,
      };
    },
  );

  return { questions, timeoutSeconds: normalizeQuestionTimeoutSeconds(params.timeoutSeconds) };
}

/** Shared human-question wait contract, including credential entry and harness watchdogs. */
export function normalizeQuestionTimeoutSeconds(rawTimeoutSeconds: unknown): number {
  if (
    rawTimeoutSeconds !== undefined &&
    (typeof rawTimeoutSeconds !== "number" ||
      !Number.isFinite(rawTimeoutSeconds) ||
      !Number.isInteger(rawTimeoutSeconds))
  ) {
    throw new ToolInputError("timeoutSeconds must be an integer");
  }
  return Math.min(
    MAX_ASK_USER_TIMEOUT_SECONDS,
    Math.max(MIN_ASK_USER_TIMEOUT_SECONDS, rawTimeoutSeconds ?? DEFAULT_ASK_USER_TIMEOUT_SECONDS),
  );
}

export const AskUserToolSchema = Type.Object(
  {
    questions: Type.Array(
      Type.Object(
        {
          id: Type.String({
            minLength: 1,
            pattern: "^[a-z][a-z0-9_]*$",
            description: "Unique snake_case answer key.",
          }),
          header: Type.String({
            minLength: 1,
            description: "Short chip label; longer input is truncated to 12 characters.",
          }),
          question: Type.String({
            minLength: 1,
            description: "Single-sentence question only. Put all selectable choices in options.",
          }),
          options: Type.Array(
            Type.Object(
              {
                label: Type.String({ minLength: 1 }),
                description: Type.Optional(Type.String()),
              },
              { additionalProperties: false },
            ),
            {
              minItems: 2,
              maxItems: 4,
              description:
                "Every selectable choice. Put the recommended choice first; do not repeat choices only in the question text.",
            },
          ),
          multiSelect: Type.Optional(
            Type.Boolean({
              description: "True only when the user may choose several options at once.",
            }),
          ),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 3 },
    ),
    timeoutSeconds: Type.Optional(
      Type.Integer({
        description:
          "Maximum human wait in seconds; default 900, clamped 30-3600. Earlier run cancellation or overall run timeout still applies.",
      }),
    ),
  },
  { additionalProperties: false },
);
