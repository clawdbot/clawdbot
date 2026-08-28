export * from "./subagent-spawn.js";
import { getSubagentSpawnDeps } from "./subagent-spawn-deps.js";

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
    | "loadPreparedModelCatalog"
    | "resolveContextEngine"
  >,
  "getGlobalHookRunner"
> & {
  getGlobalHookRunner: () => import("../../../plugins/hooks.js").SubagentLifecycleHookRunner | null;
};

export const testing: {
  setDepsForTest(overrides?: Partial<SpawnDeps>): void;
} = {
  setDepsForTest(overrides) {
    Object.assign(spawnDeps, defaultSpawnDeps, overrides);
  },
};

const spawnDeps = getSubagentSpawnDeps();
const defaultSpawnDeps = { ...spawnDeps };
