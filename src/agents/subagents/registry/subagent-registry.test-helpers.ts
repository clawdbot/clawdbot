export * from "./subagent-registry.js";
export {
  buildLatestSubagentRunReadIndex,
  buildSubagentRunReadIndex,
  buildSubagentSessionListReadIndex,
  countActiveDescendantRuns,
  countPendingDescendantRuns,
  getLatestLiveSubagentRunByChildSessionKey,
  getLatestSubagentRunByChildSessionKey,
  getSessionDisplaySubagentRunByChildSessionKey,
  getSubagentRunByChildSessionKey,
  getSubagentSessionRuntimeMs,
  getSubagentSessionStartedAt,
  hasDescendantRunAwaitingSettle,
  isSubagentRunLive,
  isSubagentSessionRunActive,
  listDescendantRunsForRequester,
  listSubagentRunsForController,
  listSubagentRunsForRequester,
  resolveRequesterForChildSession,
  resolveSubagentSessionStatus,
  shouldIgnorePostCompletionAnnounceForSession,
} from "./subagent-registry-read.js";

import { collectSessionMaintenancePreserveKeys } from "../../../config/sessions/store-maintenance-preserve.js";
import {
  createSubagentRunRecord,
  type SubagentRunRecordOverrides,
} from "../../subagent-test-fixtures.test-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

type RegistryTestApi = {
  addSubagentRunForTests(entry: SubagentRunRecord): void;
  finalizeInterruptedSubagentRun(params: {
    runId: string;
    expectedEntry?: SubagentRunRecord;
    error: string;
    endedAt?: number;
    suppressSessionEffects?: boolean;
  }): Promise<number>;
  releaseSubagentRun(runId: string): void;
  resetSubagentRegistryForTests(opts?: { persist?: boolean }): void;
  testing: {
    failQueuedSubagentRun(runId: string, error: string): boolean;
    sweepOnceForTests(): Promise<void>;
    runSweeperTickForTests(): Promise<void>;
    setDepsForTest(overrides?: Partial<RegistryDeps>): void;
  };
};

type RegistryDeps = {
  callGateway: typeof import("../../../gateway/call.js").callGateway;
  captureSubagentCompletionReply: typeof import("../announce/subagent-announce.js").captureSubagentCompletionReply;
  cleanupBrowserSessionsForLifecycleEnd: typeof import("../../../browser-lifecycle-cleanup.js").cleanupBrowserSessionsForLifecycleEnd;
  getRuntimeConfig: typeof import("../../../config/config.js").getRuntimeConfig;
  onAgentEvent: typeof import("../../../infra/agent-events.js").onAgentEvent;
  persistSubagentRunsToDisk: typeof import("./subagent-registry-state.js").persistSubagentRunsToDisk;
  persistSubagentRunsToDiskOrThrow: typeof import("./subagent-registry-state.js").persistSubagentRunsToDiskOrThrow;
  resolveAgentTimeoutMs: typeof import("../../timeout.js").resolveAgentTimeoutMs;
  restoreSubagentRunsFromDisk: typeof import("./subagent-registry-state.js").restoreSubagentRunsFromDisk;
  runSubagentAnnounceFlow: typeof import("../announce/subagent-announce.js").runSubagentAnnounceFlow;
  maybeWakeRequesterAfterAllChildrenSettled: typeof import("../announce/subagent-announce.requester-settle-wake.js").maybeWakeRequesterAfterAllChildrenSettled;
  ensureContextEnginesInitialized?: () => void;
  loadAgentRuntimePluginRegistryHandle?: import("./subagent-registry-deps.js").SubagentRegistryDeps["loadAgentRuntimePluginRegistryHandle"];
  resolveContextEngine?: typeof import("../../../context-engine/registry.js").resolveContextEngine;
};

// Keep fixture mutations on the same registry instance as the reader exports above.
// A plugin source import can publish another test handle on the process global.
const registryTestApi = (globalThis as Record<PropertyKey, unknown>)[
  Symbol.for("openclaw.subagentRegistryTestApi")
] as RegistryTestApi;

export function resetSubagentRegistryForTests(opts?: { persist?: boolean }) {
  registryTestApi.resetSubagentRegistryForTests(opts);
}

export function addSubagentRunForTests(entry: SubagentRunRecordOverrides) {
  const canonical = createSubagentRunRecord(entry);
  const target = entry as Record<string, unknown>;
  for (const key of Object.keys(target)) {
    delete target[key];
  }
  Object.assign(target, canonical);
  registryTestApi.addSubagentRunForTests(entry as SubagentRunRecord);
}

export function releaseSubagentRun(runId: string) {
  registryTestApi.releaseSubagentRun(runId);
}

export async function finalizeInterruptedSubagentRun(params: {
  runId: string;
  expectedEntry?: SubagentRunRecord;
  error: string;
  endedAt?: number;
}) {
  return await registryTestApi.finalizeInterruptedSubagentRun(params);
}

export const testing = {
  failQueuedSubagentRun: (runId: string, error: string) =>
    registryTestApi.testing.failQueuedSubagentRun(runId, error),
  sweepOnceForTests: () => registryTestApi.testing.sweepOnceForTests(),
  runSweeperTickForTests: () => registryTestApi.testing.runSweeperTickForTests(),
  setDepsForTest: (overrides?: Partial<RegistryDeps>) =>
    registryTestApi.testing.setDepsForTest(overrides),
};

export function listSessionMaintenanceProtectedSubagentSessionKeys() {
  return [...(collectSessionMaintenancePreserveKeys() ?? [])];
}
