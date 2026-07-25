import "./sessions.js";

type SessionsCommandTestApi = {
  parseSessionsLimit(value: string | undefined): number;
};

function getTestApi(): SessionsCommandTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.sessionsCommandTestApi")
  ] as SessionsCommandTestApi;
}

export const testing: SessionsCommandTestApi = {
  parseSessionsLimit(value) {
    return getTestApi().parseSessionsLimit(value);
  },
};
