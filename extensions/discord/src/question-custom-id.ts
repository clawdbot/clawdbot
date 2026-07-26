// Discord-private ask_user component envelope.
import type { ComponentData } from "./internal/discord.js";

const DISCORD_QUESTION_CUSTOM_ID_MAX_CHARS = 100;
const QUESTION_RECORD_ID_PATTERN = /^ask_[a-f0-9]{32}$/u;

type DiscordQuestionCallback = {
  questionId: string;
  optionIndex: number;
};

export function buildDiscordQuestionCustomId(
  callback: DiscordQuestionCallback,
): string | undefined {
  if (
    !QUESTION_RECORD_ID_PATTERN.test(callback.questionId) ||
    !Number.isInteger(callback.optionIndex) ||
    callback.optionIndex < 0 ||
    callback.optionIndex > 3
  ) {
    return undefined;
  }
  const customId = `ocq:id=${callback.questionId};i=${callback.optionIndex}`;
  return customId.length <= DISCORD_QUESTION_CUSTOM_ID_MAX_CHARS ? customId : undefined;
}

export function parseDiscordQuestionData(data: ComponentData): DiscordQuestionCallback | null {
  const questionId = typeof data.id === "string" ? data.id : "";
  const rawIndex =
    typeof data.i === "string" ? data.i : typeof data.i === "number" ? String(data.i) : "";
  if (!QUESTION_RECORD_ID_PATTERN.test(questionId) || !/^[0-3]$/u.test(rawIndex)) {
    return null;
  }
  return { questionId, optionIndex: Number(rawIndex) };
}
