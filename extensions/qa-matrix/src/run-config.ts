export type QaProviderMode = "mock-openai" | "live-frontier";
export type QaProviderModeInput = QaProviderMode | "live-openai";

export function normalizeQaProviderMode(input: unknown): QaProviderMode {
  if (input === "mock-openai") {
    return "mock-openai";
  }
  return "live-frontier";
}
