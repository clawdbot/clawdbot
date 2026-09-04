/** Shared registration, wait, and cancellation for blocking Gateway questions. */
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { Value } from "typebox/value";
import {
  QuestionWaitAnswerResultSchema,
  type QuestionWaitAnswerResult,
} from "../../../packages/gateway-protocol/src/index.js";
import type { callGatewayTool } from "./gateway.js";

/** Grace added to Gateway RPC deadlines so the question's own timeout wins. */
const QUESTION_RPC_GRACE_MS = 10_000;

export type GatewayQuestionCall = (...args: Parameters<typeof callGatewayTool>) => Promise<unknown>;

const TERMINAL_QUESTION_ERROR_REASONS = new Set([
  "QUESTION_ALREADY_TERMINAL",
  "QUESTION_NOT_FOUND",
]);

/** Reads the Gateway's structured failure reason from a question RPC rejection. */
export function readQuestionErrorReason(error: unknown): string | undefined {
  const requestError = asNullableRecord(error);
  if (requestError?.name !== "GatewayClientRequestError") {
    return undefined;
  }
  const reason = asNullableRecord(requestError.details)?.reason;
  return typeof reason === "string" ? reason : undefined;
}

function isTerminalQuestionResolveError(error: unknown): boolean {
  const reason = readQuestionErrorReason(error);
  return reason !== undefined && TERMINAL_QUESTION_ERROR_REASONS.has(reason);
}

/** Waits for one question's terminal state, validating the Gateway's payload. */
export async function awaitGatewayQuestionAnswer(params: {
  gatewayCall: GatewayQuestionCall;
  questionId: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<QuestionWaitAnswerResult> {
  const result = await params.gatewayCall(
    "question.waitAnswer",
    { timeoutMs: params.timeoutMs + QUESTION_RPC_GRACE_MS },
    { id: params.questionId, timeoutMs: params.timeoutMs },
    params.signal ? { signal: params.signal } : undefined,
  );
  if (!Value.Check(QuestionWaitAnswerResultSchema, result)) {
    throw new Error("question.waitAnswer returned an invalid status");
  }
  return result;
}

/**
 * Cancels a pending question at most once. An answer that lands between the
 * caller's timeout and this cancel makes the Gateway reject it as terminal; the
 * recovery read returns that answer so a submitted response is never discarded.
 */
export function createGatewayQuestionCanceller(params: {
  gatewayCall: GatewayQuestionCall;
  questionId: string;
}): (
  resolvedBy: string,
) => Promise<Extract<QuestionWaitAnswerResult, { status: "answered" }> | undefined> {
  let cancellation:
    | Promise<Extract<QuestionWaitAnswerResult, { status: "answered" }> | undefined>
    | undefined;
  return (resolvedBy: string) => {
    cancellation ??= (async () => {
      try {
        await params.gatewayCall(
          "question.resolve",
          { timeoutMs: QUESTION_RPC_GRACE_MS },
          { id: params.questionId, cancel: true, resolvedBy },
        );
        return undefined;
      } catch (error) {
        if (!isTerminalQuestionResolveError(error)) {
          return undefined;
        }
        try {
          const result = await awaitGatewayQuestionAnswer({
            gatewayCall: params.gatewayCall,
            questionId: params.questionId,
            timeoutMs: 1_000,
          });
          return result.status === "answered" ? result : undefined;
        } catch {
          return undefined;
        }
      }
    })();
    return cancellation;
  };
}
