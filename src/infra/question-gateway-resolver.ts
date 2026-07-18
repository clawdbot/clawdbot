// Resolves runtime-authored question choices through the Gateway.
import type {
  QuestionGetResult,
  QuestionResolveResult,
} from "../../packages/gateway-protocol/src/schema/questions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { callGateway } from "../gateway/call.js";

const QUESTION_RECORD_ID_PATTERN = /^ask_[a-f0-9]{32}$/u;

export type ResolveQuestionOverGatewayResult =
  | { status: "answered"; questionId: string; optionValue: string }
  | { status: "already-terminal"; reason: "already-terminal" | "not-found" };

export type ResolveQuestionOverGatewayParams = {
  cfg: OpenClawConfig;
  questionId: string;
  optionIndex: number;
  senderId?: string | null;
  gatewayUrl?: string;
  clientDisplayName?: string;
};

function readTerminalReason(error: unknown): "already-terminal" | "not-found" | undefined {
  if (!(error instanceof Error) || error.name !== "GatewayClientRequestError") {
    return undefined;
  }
  const details = (error as Error & { details?: unknown }).details;
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return undefined;
  }
  const reason = (details as { reason?: unknown }).reason;
  if (reason === "QUESTION_ALREADY_TERMINAL") {
    return "already-terminal";
  }
  return reason === "QUESTION_NOT_FOUND" ? "not-found" : undefined;
}

/** Maps a compact option index to the canonical label, then resolves the question atomically. */
export async function resolveQuestionOverGateway(
  params: ResolveQuestionOverGatewayParams,
): Promise<ResolveQuestionOverGatewayResult> {
  if (!QUESTION_RECORD_ID_PATTERN.test(params.questionId)) {
    throw new Error("question resolution requires a valid question record id");
  }
  if (!Number.isInteger(params.optionIndex) || params.optionIndex < 0) {
    throw new Error("question resolution requires a valid option index");
  }
  const gatewayOptions = {
    config: params.cfg,
    url: params.gatewayUrl,
    scopes: ["operator.questions" as const],
    clientDisplayName:
      params.clientDisplayName ?? `Question (${params.senderId?.trim() || "unknown"})`,
  };
  let getResult: QuestionGetResult;
  try {
    getResult = await callGateway<QuestionGetResult>({
      ...gatewayOptions,
      method: "question.get",
      params: { id: params.questionId },
    });
  } catch (error) {
    const reason = readTerminalReason(error);
    if (reason) {
      return { status: "already-terminal", reason };
    }
    throw error;
  }

  const record = getResult.question;
  if (record.status !== "pending") {
    return { status: "already-terminal", reason: "already-terminal" };
  }
  const question = record.questions.length === 1 ? record.questions[0] : undefined;
  if (!question || question.multiSelect || question.isSecret) {
    throw new Error("question button resolution requires one tappable question");
  }
  const optionValue = question.options[params.optionIndex]?.label;
  if (!optionValue) {
    throw new Error("question resolution option index is out of range");
  }

  try {
    await callGateway<QuestionResolveResult>({
      ...gatewayOptions,
      method: "question.resolve",
      params: {
        id: params.questionId,
        answers: { answers: { [question.id]: { answers: [optionValue] } } },
        resolvedBy: params.senderId?.trim() || undefined,
      },
    });
  } catch (error) {
    const reason = readTerminalReason(error);
    if (reason) {
      return { status: "already-terminal", reason };
    }
    throw error;
  }
  return { status: "answered", questionId: question.id, optionValue };
}
