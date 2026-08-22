import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SubagentLifecycleHookRunner } from "../../../plugins/hooks.js";
import { hasPromptUnsafeControlCharacter } from "../../sanitize-for-prompt.js";
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

export function sanitizeSubagentMountPathHint(value?: string): string | undefined {
  const trimmed = normalizeOptionalString(value);
  if (
    !trimmed ||
    hasPromptUnsafeControlCharacter(trimmed) ||
    !/^[A-Za-z0-9._\-/:]+$/.test(trimmed)
  ) {
    return undefined;
  }
  return trimmed;
}

const testing = {
  setDepsForTest(overrides?: Partial<SubagentSpawnDeps>) {
    setSubagentSpawnDepsForTest(overrides);
  },
};
if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.subagentSpawnTestApi")] =
    testing;
}
