import type { SubagentLifecycleHookRunner } from "../../../plugins/hooks.js";
import { getSandboxBackendManager } from "../../sandbox/backend.js";
import {
  callGateway,
  createSandboxWorkspaceIngressFsBridge,
  dispatchGatewayMethodInProcess,
  ensureContextEnginesInitialized,
  forkSessionEntryFromParent,
  getGlobalHookRunner,
  getRuntimeConfig,
  hasInProcessGatewayContext,
  loadPreparedModelCatalog,
  resolveContextEngine,
  resolveSandboxContext,
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
  resolveContextEngine: typeof resolveContextEngine;
  createSandboxWorkspaceIngressFsBridge: typeof createSandboxWorkspaceIngressFsBridge;
  resolveSandboxContext: typeof resolveSandboxContext;
  getSandboxBackendManager: typeof getSandboxBackendManager;
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
  resolveContextEngine,
  createSandboxWorkspaceIngressFsBridge,
  resolveSandboxContext,
  getSandboxBackendManager,
};

let subagentSpawnDeps = defaultSubagentSpawnDeps;

export function getSubagentSpawnDeps(): SubagentSpawnDeps {
  return subagentSpawnDeps;
}

function setSubagentSpawnDepsForTest(overrides?: Partial<SubagentSpawnDeps>): void {
  subagentSpawnDeps = overrides
    ? {
        ...defaultSubagentSpawnDeps,
        ...overrides,
      }
    : defaultSubagentSpawnDeps;
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.subagentSpawnTestApi")] = {
    setDepsForTest: setSubagentSpawnDepsForTest,
  };
}
