import "./agent-tools.before-tool-call.js";

type BeforeToolCallBlockedErrorTestApi = {
  create(message: string): Error;
};

const testing = (globalThis as Record<PropertyKey, unknown>)[
  Symbol.for("openclaw.beforeToolCallBlockedErrorTestApi")
] as BeforeToolCallBlockedErrorTestApi;

export function createBeforeToolCallBlockedError(message: string): Error {
  return testing.create(message);
}
