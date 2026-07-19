export * from "./subagent-spawn.js";

type SpawnRuntime = typeof import("./subagent-spawn.runtime.js");
type SpawnDeps = Omit<
  Pick<
    SpawnRuntime,
    | "callGateway"
    | "dispatchGatewayMethodInProcess"
    | "ensureContextEnginesInitialized"
    | "forkSessionEntryFromParent"
    | "getGlobalHookRunner"
    | "getRuntimeConfig"
    | "hasInProcessGatewayContext"
    | "loadModelCatalog"
    | "resolveContextEngine"
  >,
  "getGlobalHookRunner"
> & {
  getGlobalHookRunner: () => import("../plugins/hooks.js").SubagentLifecycleHookRunner | null;
};

type Testing = {
  setDepsForTest(overrides?: Partial<SpawnDeps>): void;
};

function getTesting(): Testing {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.subagentSpawnTestApi")
  ] as Testing;
}

export const testing: Testing = {
  setDepsForTest: (overrides) => getTesting().setDepsForTest(overrides),
};
