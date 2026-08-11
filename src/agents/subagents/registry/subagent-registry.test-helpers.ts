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
import { subagentRuns } from "./subagent-registry-memory.js";
import { countPendingDescendantRunsExcludingRunFromRuns } from "./subagent-registry-queries.js";
import { getSubagentRunsSnapshotForRead } from "./subagent-registry-state.js";
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
  getGatewayRecoveryRuntime: () =>
    | import("../../../gateway/server-instance-runtime.types.js").GatewayRecoveryRuntime
    | undefined;
  captureSubagentCompletionReply: typeof import("../announce/subagent-announce.js").captureSubagentCompletionReply;
  cleanupBrowserSessionsForLifecycleEnd: typeof import("../../../browser-lifecycle-cleanup.js").cleanupBrowserSessionsForLifecycleEnd;
  getSubagentRunsSnapshotForRead: typeof import("./subagent-registry-state.js").getSubagentRunsSnapshotForRead;
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

function getRegistryTestApi(): RegistryTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.subagentRegistryTestApi")
  ] as RegistryTestApi;
}

export function resetSubagentRegistryForTests(opts?: { persist?: boolean }) {
  getRegistryTestApi().resetSubagentRegistryForTests(opts);
}

export function addSubagentRunForTests(entry: SubagentRunRecordOverrides) {
  const canonical = createSubagentRunRecord(entry);
  const target = entry as Record<string, unknown>;
  for (const key of Object.keys(target)) {
    delete target[key];
  }
  Object.assign(target, canonical);
  getRegistryTestApi().addSubagentRunForTests(entry as SubagentRunRecord);
}

export function releaseSubagentRun(runId: string) {
  getRegistryTestApi().releaseSubagentRun(runId);
}

export async function finalizeInterruptedSubagentRun(params: {
  runId: string;
  expectedEntry?: SubagentRunRecord;
  error: string;
  endedAt?: number;
}) {
  return await getRegistryTestApi().finalizeInterruptedSubagentRun(params);
}

export const testing = {
  failQueuedSubagentRun: (runId: string, error: string) =>
    getRegistryTestApi().testing.failQueuedSubagentRun(runId, error),
  sweepOnceForTests: () => getRegistryTestApi().testing.sweepOnceForTests(),
  runSweeperTickForTests: () => getRegistryTestApi().testing.runSweeperTickForTests(),
  setDepsForTest: (overrides?: Partial<RegistryDeps>) =>
    getRegistryTestApi().testing.setDepsForTest(overrides),
};

export function countPendingDescendantRunsExcludingRun(
  rootSessionKey: string,
  excludeRunId: string,
) {
  return countPendingDescendantRunsExcludingRunFromRuns(
    getSubagentRunsSnapshotForRead(subagentRuns),
    rootSessionKey,
    excludeRunId,
  );
}

export function listSessionMaintenanceProtectedSubagentSessionKeys() {
  return [...(collectSessionMaintenancePreserveKeys() ?? [])];
}
