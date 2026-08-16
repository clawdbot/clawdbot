import "./runner.js";

type MediaUnderstandingRunnerTestApi = {
  clearMediaUnderstandingBinaryCacheForTests(): void;
};

function getTestApi(): MediaUnderstandingRunnerTestApi {
  const api = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.mediaUnderstandingRunnerTestApi")
  ];
  if (!api) {
    throw new Error("media understanding runner test API is unavailable");
  }
  return api as MediaUnderstandingRunnerTestApi;
}

export function clearMediaUnderstandingBinaryCacheForTests(): void {
  getTestApi().clearMediaUnderstandingBinaryCacheForTests();
}
