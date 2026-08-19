import "./session-suspension.js";

type SessionSuspensionTestApi = {
  resetSessionSuspensionStateForTest(): void;
};

function getTestApi(): SessionSuspensionTestApi {
  const api = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.sessionSuspensionTestApi")
  ];
  if (!api) {
    throw new Error("session suspension test API is unavailable");
  }
  return api as SessionSuspensionTestApi;
}

export function resetSessionSuspensionStateForTest(): void {
  getTestApi().resetSessionSuspensionStateForTest();
}
