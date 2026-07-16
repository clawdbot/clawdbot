import "./attempt.session-lock.js";

type EmbeddedAttemptSessionFileOwnersTestApi = {
  resetEmbeddedAttemptSessionFileOwnersForTest(): void;
};

function getTestApi(): EmbeddedAttemptSessionFileOwnersTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.embeddedAttemptSessionFileOwnersTestApi")
  ] as EmbeddedAttemptSessionFileOwnersTestApi;
}

export function resetEmbeddedAttemptSessionFileOwnersForTest(): void {
  getTestApi().resetEmbeddedAttemptSessionFileOwnersForTest();
}
