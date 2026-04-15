export type QaProviderMode = "mock-openai" | "live-frontier";
export type QaProviderModeInput = QaProviderMode | "live-openai";

export type QaModelSelection = {
  primaryModel: string;
  alternateModel: string;
};

export function normalizeQaProviderMode(mode: QaProviderModeInput): QaProviderMode {
  return mode === "live-openai" ? "live-frontier" : mode;
}

export function defaultQaModelForMode(
  mode: QaProviderModeInput,
  options?: {
    alternate?: boolean;
    preferredLiveModel?: string;
  },
) {
  if (normalizeQaProviderMode(mode) === "live-frontier") {
    return options?.preferredLiveModel ?? "openai/gpt-5.4";
  }
  return options?.alternate ? "mock-openai/gpt-5.4-alt" : "mock-openai/gpt-5.4";
}

export function splitQaModelRef(ref: string) {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) {
    return null;
  }
  return {
    provider: ref.slice(0, slash),
    model: ref.slice(slash + 1),
  };
}

export function isQaFastModeModelRef(ref: string) {
  return splitQaModelRef(ref)?.provider === "openai";
}

export function isQaFastModeEnabled(selection: QaModelSelection) {
  return (
    isQaFastModeModelRef(selection.primaryModel) || isQaFastModeModelRef(selection.alternateModel)
  );
}
