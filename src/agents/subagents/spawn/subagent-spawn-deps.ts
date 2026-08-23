import type { SubagentLifecycleHookRunner } from "../../../plugins/hooks.js";
import {
  callGateway,
  dispatchGatewayMethodInProcess,
  ensureContextEnginesInitialized,
  forkSessionEntryFromParent,
  getGlobalHookRunner,
  getRuntimeConfig,
  hasInProcessGatewayContext,
  loadPreparedModelCatalog,
  resolveProviderRefOwnership,
  resolveContextEngine,
} from "./subagent-spawn.runtime.js";

type SubagentSpawnDeps = {
  callGateway: typeof callGateway;
  dispatchGatewayMethodInProcess: typeof dispatchGatewayMethodInProcess;
  forkSessionEntryFromParent: typeof forkSessionEntryFromParent;
  getGlobalHookRunner: () => SubagentLifecycleHookRunner | null;
  getRuntimeConfig: typeof getRuntimeConfig;
  hasInProcessGatewayContext: typeof hasInProcessGatewayContext;
  ensureContextEnginesInitialized: typeof ensureContextEnginesInitialized;
  loadPreparedModelCatalog: typeof loadPreparedModelCatalog;
  resolveProviderRefOwnership: typeof resolveProviderRefOwnership;
  resolveContextEngine: typeof resolveContextEngine;
};

const defaultSubagentSpawnDeps: SubagentSpawnDeps = {
  callGateway,
  dispatchGatewayMethodInProcess,
  forkSessionEntryFromParent,
  getGlobalHookRunner,
  getRuntimeConfig,
  hasInProcessGatewayContext,
  ensureContextEnginesInitialized,
  loadPreparedModelCatalog,
  resolveProviderRefOwnership,
  resolveContextEngine,
};

let subagentSpawnDeps = defaultSubagentSpawnDeps;

export function getSubagentSpawnDeps(): SubagentSpawnDeps {
  return subagentSpawnDeps;
}

export function setSubagentSpawnDepsForTest(overrides?: Partial<SubagentSpawnDeps>): void {
  subagentSpawnDeps = overrides
    ? {
        ...defaultSubagentSpawnDeps,
        ...overrides,
      }
    : defaultSubagentSpawnDeps;
}
