import "./runs.js";

type EmbeddedRunsTestApi = {
  persistForceClearedEmbeddedRunTerminalState(params: {
    sessionId: string;
    sessionKey: string;
    startedAt?: number;
    storePath: string;
    updatedAt: number;
  }): Promise<void>;
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
