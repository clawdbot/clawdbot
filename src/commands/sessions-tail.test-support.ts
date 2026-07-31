import "./sessions-tail.js";

type SessionsTailTestApi = {
  setSessionsTailFollowIntervalMsForTests(intervalMs?: number): void;
};

function getTestApi(): SessionsTailTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.sessionsTailTestApi")
  ] as SessionsTailTestApi;
}

export function setSessionsTailFollowIntervalMsForTests(intervalMs?: number): void {
  getTestApi().setSessionsTailFollowIntervalMsForTests(intervalMs);
}
