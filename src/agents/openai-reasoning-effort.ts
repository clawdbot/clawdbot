export type OpenAIReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

export type OpenAIApiReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh";

export function normalizeOpenAIReasoningEffort(effort: string): string {
  return effort === "minimal" ? "low" : effort;
}
