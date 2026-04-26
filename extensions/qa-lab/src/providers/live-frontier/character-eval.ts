import type { QaThinkingLevel } from "../../qa-thinking.js";

type QaFrontierCharacterModelOptions = {
  thinkingDefault?: QaThinkingLevel;
  fastMode?: boolean;
};

export const QA_FRONTIER_CHARACTER_EVAL_MODELS = Object.freeze([
  "openai/gpt-5.5",
  "openai/gpt-5.2",
  "openai/gpt-5",
  "anthropic/claude-opus-4-6",
  "anthropic/claude-sonnet-4-6",
  "zai/glm-5.1",
  "moonshot/kimi-k2.5",
  "google/gemini-3.1-pro-preview",
]);

export const QA_FRONTIER_CHARACTER_THINKING_BY_MODEL: Readonly<Record<string, QaThinkingLevel>> =
  Object.freeze({
    "openai/gpt-5.5": "medium",
    "openai/gpt-5.2": "xhigh",
    "openai/gpt-5": "xhigh",
  });

export const QA_FRONTIER_CHARACTER_JUDGE_MODELS = Object.freeze([
  "openai/gpt-5.5",
  "anthropic/claude-opus-4-6",
]);

export const QA_FRONTIER_CHARACTER_JUDGE_MODEL_OPTIONS: Readonly<
  Record<string, QaFrontierCharacterModelOptions>
> = Object.freeze({
  "openai/gpt-5.5": { thinkingDefault: "xhigh", fastMode: true },
  "anthropic/claude-opus-4-6": { thinkingDefault: "high" },
});
