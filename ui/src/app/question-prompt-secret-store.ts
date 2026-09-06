// Store-bound question ownership keeps credential metadata and plaintext handling together.
import { asSafeIntegerInRange } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeNullableString } from "@openclaw/normalization-core/string-coerce";
import type {
  Question,
  QuestionAnswers,
  QuestionResolveParams,
  QuestionResolveResult,
} from "../../../packages/gateway-protocol/src/index.js";

type QuestionSecretStoreFields = Pick<Question, "isSecret" | "secretStore" | "secretStoreExisting">;

function parseQuestionSecretStore(value: unknown): NonNullable<Question["secretStore"]> | null {
  if (!isRecord(value)) {
    return null;
  }
  const { name, kind, allowedHosts, reason } = value;
  if (
    typeof name !== "string" ||
    !/^[A-Z][A-Z0-9_]{0,127}$/.test(name) ||
    (kind !== "secret" && kind !== "env") ||
    (reason !== undefined && (typeof reason !== "string" || reason.length > 200))
  ) {
    return null;
  }
  if (
    allowedHosts !== undefined &&
    (kind !== "secret" ||
      !Array.isArray(allowedHosts) ||
      allowedHosts.length > 128 ||
      allowedHosts.some((host) => typeof host !== "string" || !host || host.length > 253) ||
      new Set(allowedHosts).size !== allowedHosts.length)
  ) {
    return null;
  }
  return {
    name,
    kind,
    ...(allowedHosts !== undefined ? { allowedHosts: [...allowedHosts] } : {}),
    ...(reason !== undefined ? { reason } : {}),
  };
}

function parseQuestionSecretStoreExisting(
  value: unknown,
): NonNullable<Question["secretStoreExisting"]> | null {
  if (!isRecord(value)) {
    return null;
  }
  const updatedAtMs = asSafeIntegerInRange(value.updatedAtMs, { min: 0 });
  const updatedBy =
    value.updatedBy === undefined ? undefined : normalizeNullableString(value.updatedBy);
  if (updatedAtMs === undefined || (value.updatedBy !== undefined && !updatedBy)) {
    return null;
  }
  return { updatedAtMs, ...(updatedBy ? { updatedBy } : {}) };
}

export function normalizeQuestionSecretStoreFields(
  value: Record<string, unknown>,
): QuestionSecretStoreFields | null {
  if (value.isSecret !== undefined && typeof value.isSecret !== "boolean") {
    return null;
  }
  const secretStore =
    value.secretStore === undefined ? undefined : parseQuestionSecretStore(value.secretStore);
  const secretStoreExisting =
    value.secretStoreExisting === undefined
      ? undefined
      : parseQuestionSecretStoreExisting(value.secretStoreExisting);
  if (
    secretStore === null ||
    secretStoreExisting === null ||
    (secretStore && !value.isSecret) ||
    (secretStoreExisting && !secretStore)
  ) {
    return null;
  }
  return {
    ...(typeof value.isSecret === "boolean" ? { isSecret: value.isSecret } : {}),
    ...(secretStore ? { secretStore } : {}),
    ...(secretStoreExisting ? { secretStoreExisting } : {}),
  };
}

export function clearSecretQuestionDrafts(
  questions: readonly Question[],
  drafts: { delete: (questionId: string) => boolean },
): void {
  for (const question of questions) {
    if (question.isSecret) {
      drafts.delete(question.questionId);
    }
  }
}

export function parseQuestionSubmissionResult(
  value: unknown,
  parseAnswers: (value: unknown) => QuestionAnswers | null,
): QuestionResolveResult | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value.status === "cancelled") {
    return { status: "cancelled" };
  }
  const answers = parseAnswers(value.answers);
  return value.status === "answered" && answers ? { status: "answered", answers } : null;
}

export function prepareQuestionSecretStoreSubmission(
  id: string,
  questions: readonly Question[],
  resolution: { answers: QuestionAnswers["answers"] } | { cancel: true },
  allowedHostsDraft?: string,
): { requestParams: QuestionResolveParams; submittedAnswers?: QuestionAnswers } {
  if (!("answers" in resolution)) {
    return { requestParams: { id, cancel: true } };
  }
  const requestAnswers: QuestionAnswers = {
    answers: Object.fromEntries(
      Object.entries(resolution.answers).map(([questionId, answers]) => [questionId, [...answers]]),
    ),
  };
  const secretQuestion = questions[0]?.secretStore ? questions[0] : undefined;
  const allowedHosts =
    secretQuestion?.secretStore?.kind === "secret"
      ? allowedHostsDraft !== undefined
        ? allowedHostsDraft
            .split(/[,\s]+/u)
            .map((host) => host.trim())
            .filter(Boolean)
        : secretQuestion.secretStore.allowedHosts
      : undefined;
  return {
    requestParams: {
      id,
      answers: requestAnswers,
      ...(allowedHosts !== undefined ? { secretStoreAllowedHosts: allowedHosts } : {}),
    },
    // The Gateway owns redaction: retained prompt state receives its synthetic
    // marker while plaintext remains only in the outbound request payload.
    submittedAnswers: secretQuestion
      ? { answers: { [secretQuestion.questionId]: ["stored"] } }
      : requestAnswers,
  };
}
