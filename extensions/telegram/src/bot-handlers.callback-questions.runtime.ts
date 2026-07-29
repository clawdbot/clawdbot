// Telegram ask_user callback resolution and toast feedback.
import { questionGatewayRuntime } from "openclaw/plugin-sdk/question-gateway-runtime";
import type { TelegramQuestionCallback } from "./question-callback-data.js";

type ResolveQuestionParams = Parameters<typeof questionGatewayRuntime.resolveOption>[0];
type QuestionResolver = (
  params: ResolveQuestionParams,
) => ReturnType<typeof questionGatewayRuntime.resolveOption>;

export async function handleTelegramQuestionCallback(params: {
  callback: TelegramQuestionCallback;
  cfg: ResolveQuestionParams["cfg"];
  senderId: string;
  feedback: (text: string, terminal: boolean) => Promise<unknown>;
  resolveQuestion?: QuestionResolver;
}): Promise<void> {
  let result: Awaited<ReturnType<QuestionResolver>>;
  try {
    result = await (params.resolveQuestion ?? questionGatewayRuntime.resolveOption)({
      cfg: params.cfg,
      questionId: params.callback.questionId,
      optionIndex: params.callback.optionIndex,
      senderId: params.senderId,
      clientDisplayName: "Telegram question",
    });
  } catch (error) {
    await params.feedback("Could not submit this answer.", false).catch(() => {});
    throw error;
  }
  await params
    .feedback(
      result.status === "answered" ? "Answer submitted." : "This question was already answered.",
      true,
    )
    .catch(() => {});
}
