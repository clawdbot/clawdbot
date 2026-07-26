import type { CallGatewayOptions } from "../../gateway/call.js";
import "./sessions-send-tool.a2a.js";

type GatewayCaller = <T = unknown>(opts: CallGatewayOptions) => Promise<T>;

type SessionsSendA2ATestApi = {
  testing: {
    setDepsForTest(overrides?: Partial<{ callGateway: GatewayCaller }>): void;
  };
};

function getTestApi(): SessionsSendA2ATestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.sessionsSendA2ATestApi")
  ] as SessionsSendA2ATestApi;
}

export const testing = getTestApi().testing;
