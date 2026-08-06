import type { callGateway } from "../../gateway/call.js";
import "./sessions-resolution.js";

type SessionsResolutionTestApi = {
  testing: {
    setDepsForTest(overrides?: Partial<{ callGateway: typeof callGateway }>): void;
  };
};

function getTestApi(): SessionsResolutionTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.sessionsResolutionTestApi")
  ] as SessionsResolutionTestApi;
}

export const testing = getTestApi().testing;
