export * from "./subagent-control.js";

type ControlRuntime = typeof import("./subagent-control.runtime.js");
type ControlDeps = {
  callGateway: typeof import("../gateway/call.js").callGateway;
  patchSessionEntry: typeof import("../config/sessions/session-accessor.js").patchSessionEntry;
  abortEmbeddedAgentRun: ControlRuntime["abortEmbeddedAgentRun"];
  isEmbeddedAgentRunActive: ControlRuntime["isEmbeddedAgentRunActive"];
  clearSessionQueues: ControlRuntime["clearSessionQueues"];
};

type Testing = {
  setDepsForTest(overrides?: Partial<ControlDeps>): void;
};

function getTesting(): Testing {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.subagentControlTestApi")
  ] as Testing;
}

export const testing: Testing = {
  setDepsForTest: (overrides) => getTesting().setDepsForTest(overrides),
};
