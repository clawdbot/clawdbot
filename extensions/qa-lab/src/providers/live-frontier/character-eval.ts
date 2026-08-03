// Qa Lab plugin module implements character eval behavior.
import type { ThinkLevel } from "openclaw/plugin-sdk/thinking-level";

type QaFrontierCharacterModelOptions = {
  thinkingDefault?: ThinkLevel;
  fastMode?: boolean;
};

export const QA_FRONTIER_CHARACTER_EVAL_MODELS = Object.freeze([
  "openai/gpt-5.6-luna",
  "openai/gpt-5.2",
  "openai/gpt-5",
  "anthropic/claude-opus-4-8",
  "anthropic/claude-sonnet-4-6",
  "zai/glm-5.1",
  "moonshot/kimi-k2.5",
  "google/gemini-3.1-pro-preview",
]);

export const QA_FRONTIER_CHARACTER_THINKING_BY_MODEL: Readonly<Record<string, ThinkLevel>> =
  Object.freeze({
    "openai/gpt-5.6-luna": "medium",
    "openai/gpt-5.2": "xhigh",
    "openai/gpt-5": "xhigh",
  });

export const QA_FRONTIER_CHARACTER_JUDGE_MODELS = Object.freeze([
  "openai/gpt-5.6-sol",
  "anthropic/claude-opus-4-8",
]);

export const QA_FRONTIER_CHARACTER_JUDGE_MODEL_OPTIONS: Readonly<
  Record<string, QaFrontierCharacterModelOptions>
> = Object.freeze({
  "openai/gpt-5.6-sol": { thinkingDefault: "xhigh", fastMode: true },
  "anthropic/claude-opus-4-8": { thinkingDefault: "high" },
});
