import "./runs.js";

type EmbeddedRunsTestApi = {
  resetActiveEmbeddedRuns(): void;
};

function getTestApi(): EmbeddedRunsTestApi {
  const api = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.embeddedRunsTestApi")
  ];
  if (!api) {
    throw new Error("embedded runs test API is unavailable");
  }
  return api as EmbeddedRunsTestApi;
}

export const testing = getTestApi();
