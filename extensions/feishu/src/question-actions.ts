// Feishu-private ask_user button envelope and Gateway resolution feedback.
import { resolveExpiresAtMsFromDurationMs } from "openclaw/plugin-sdk/number-runtime";
import { questionGatewayRuntime } from "openclaw/plugin-sdk/question-gateway-runtime";
import type { FeishuCardInteractionEnvelope } from "./card-interaction.js";
import { normalizeFeishuTarget, resolveReceiveIdType } from "./targets.js";

export const FEISHU_QUESTION_ACTION = "feishu.payload.question";

// Match ask_user's maximum wait; the shared decoder rejects controls after this boundary.
const FEISHU_QUESTION_ACTION_TTL_MS = 60 * 60_000;

export type FeishuQuestionInteractionContext = NonNullable<FeishuCardInteractionEnvelope["c"]>;

export function buildFeishuQuestionInteractionContext(params: {
  operatorOpenId?: string;
  operatorUserId?: string;
  chatId?: string;
  now?: number;
}): FeishuQuestionInteractionContext | undefined {
  const expiresAt = resolveExpiresAtMsFromDurationMs(FEISHU_QUESTION_ACTION_TTL_MS, {
    nowMs: params.now,
  });
  if (expiresAt === undefined) {
    return undefined;
  }
  const operatorOpenId = params.operatorOpenId?.trim();
  const operatorUserId = params.operatorUserId?.trim();
  const chatId = params.chatId?.trim();
  return {
    ...(operatorOpenId ? { u: operatorOpenId } : {}),
    ...(operatorUserId ? { i: operatorUserId } : {}),
    ...(chatId ? { h: chatId } : {}),
    e: expiresAt,
  };
}

export function buildFeishuQuestionTargetContext(
  target: string,
  now?: number,
): FeishuQuestionInteractionContext | undefined {
  const normalizedTarget = normalizeFeishuTarget(target);
  if (!normalizedTarget) {
    return undefined;
  }
  const withoutProvider = target.replace(/^(feishu|lark):/iu, "").trim();
  const idType = resolveReceiveIdType(withoutProvider);
  if (idType === "chat_id") {
    return buildFeishuQuestionInteractionContext({ chatId: normalizedTarget, now });
  }
  return idType === "open_id"
    ? buildFeishuQuestionInteractionContext({ operatorOpenId: normalizedTarget, now })
    : buildFeishuQuestionInteractionContext({ operatorUserId: normalizedTarget, now });
}

type ResolveQuestionParams = Parameters<typeof questionGatewayRuntime.resolveOption>[0];
type QuestionResolver = (
  params: ResolveQuestionParams,
) => ReturnType<typeof questionGatewayRuntime.resolveOption>;

export async function resolveFeishuQuestionAction(params: {
  questionId: string;
  optionValue: string;
  cfg: ResolveQuestionParams["cfg"];
  accountId: string;
  userId: string;
  respond: (text: string) => Promise<void>;
  resolveQuestion?: QuestionResolver;
}): Promise<void> {
  let result: Awaited<ReturnType<QuestionResolver>>;
  try {
    result = await (params.resolveQuestion ?? questionGatewayRuntime.resolveOption)({
      cfg: params.cfg,
      questionId: params.questionId,
      optionValue: params.optionValue,
      senderId: params.userId,
      clientDisplayName: `Feishu question (${params.accountId})`,
    });
  } catch {
    await params.respond("Could not submit this answer.").catch(() => {});
    return;
  }
  await params
    .respond(
      result.status === "answered" ? "Answer submitted." : "This question was already answered.",
    )
    .catch(() => {});
}
