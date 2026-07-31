// Converts eligible portable question buttons into numbered reaction choices.
import type { ReplyPayload } from "../auto-reply/reply-payload.js";
import type { MessagePresentation } from "../interactive/payload.js";
import { renderMessagePresentationFallbackText } from "../interactive/payload.js";
import {
  resolveQuestionOverGateway,
  type ResolveQuestionOverGatewayParams,
  type ResolveQuestionOverGatewayResult,
} from "./question-gateway-resolver.js";

const QUESTION_REACTION_CHANNEL_DATA_KEY = "openclawQuestionReaction";

export const QUESTION_REACTION_EMOJIS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣"] as const;

type QuestionReactionBinding = {
  questionId: string;
  optionValues: string[];
};

export function readAskUserQuestionId(
  payload: Pick<ReplyPayload, "channelData">,
): string | undefined {
  const askUser = payload.channelData?.askUser;
  if (!askUser || typeof askUser !== "object" || Array.isArray(askUser)) {
    return undefined;
  }
  const questionId = (askUser as { questionId?: unknown }).questionId;
  return typeof questionId === "string" && questionId ? questionId : undefined;
}

export function readQuestionReactionBinding(
  payload: Pick<ReplyPayload, "channelData">,
): QuestionReactionBinding | undefined {
  const raw = payload.channelData?.[QUESTION_REACTION_CHANNEL_DATA_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const questionId = (raw as { questionId?: unknown }).questionId;
  const optionValues = (raw as { optionValues?: unknown }).optionValues;
  return typeof questionId === "string" &&
    questionId.length > 0 &&
    Array.isArray(optionValues) &&
    optionValues.length >= 1 &&
    optionValues.length <= QUESTION_REACTION_EMOJIS.length &&
    optionValues.every((value) => typeof value === "string" && value.length > 0)
    ? { questionId, optionValues: [...optionValues] }
    : undefined;
}

export function resolveQuestionReactionIndex(reaction: string): number | undefined {
  const index = QUESTION_REACTION_EMOJIS.indexOf(
    reaction as (typeof QUESTION_REACTION_EMOJIS)[number],
  );
  return index >= 0 ? index : undefined;
}

export function prepareQuestionReactionPayloadForDelivery(params: {
  payload: ReplyPayload;
  presentation?: MessagePresentation;
}): ReplyPayload | null {
  const questionId = readAskUserQuestionId(params.payload);
  const presentation = params.presentation ?? params.payload.presentation;
  if (!questionId || !presentation) {
    return null;
  }
  const buttonBlocks = presentation.blocks.filter((block) => block.type === "buttons");
  if (buttonBlocks.length !== 1) {
    return null;
  }
  const [buttonBlock] = buttonBlocks;
  if (!buttonBlock || buttonBlock.buttons.length < 1 || buttonBlock.buttons.length > 4) {
    return null;
  }
  const labels: string[] = [];
  const optionValues: string[] = [];
  for (const button of buttonBlock.buttons) {
    if (
      button.action?.type !== "question" ||
      button.action.questionId !== questionId ||
      !button.action.optionValue
    ) {
      return null;
    }
    labels.push(button.label);
    optionValues.push(button.action.optionValue);
  }
  // Keep only the leading question block: the second text block carries
  // tap-oriented option guidance that is wrong for reaction channels, and the
  // reaction hint below re-lists every option.
  const questionBlock = presentation.blocks.find((block) => block.type === "text");
  const textPresentation: MessagePresentation = {
    ...presentation,
    blocks: questionBlock ? [questionBlock] : [],
  };
  const prompt = renderMessagePresentationFallbackText({ presentation: textPresentation });
  const reactionHint = labels
    .map((label, index) => `${QUESTION_REACTION_EMOJIS[index]} ${label}`)
    .join("\n");
  return {
    ...params.payload,
    text: `${prompt}\n\nReact with:\n${reactionHint}`,
    presentation: undefined,
    presentationTextMode: undefined,
    channelData: {
      ...params.payload.channelData,
      [QUESTION_REACTION_CHANNEL_DATA_KEY]: { questionId, optionValues },
    },
  };
}

export async function resolveQuestionReactionOverGateway(
  params: ResolveQuestionOverGatewayParams,
): Promise<ResolveQuestionOverGatewayResult | null> {
  return await resolveQuestionOverGateway(params);
}
