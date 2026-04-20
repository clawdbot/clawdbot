export type QaProviderMode = "mock-openai" | "live-frontier";
export type QaProviderModeInput = QaProviderMode | "live-openai";

export function normalizeQaProviderMode(input: unknown): QaProviderMode {
  if (input === undefined || input === null || input === "") {
    return "live-frontier";
  }
  if (input === "mock-openai") {
    return "mock-openai";
  }
  if (input === "live-frontier" || input === "live-openai") {
    return "live-frontier";
  }
  const details = typeof input === "string" ? `: ${input}` : "";
  throw new Error(`unknown QA provider mode${details}`);
}
