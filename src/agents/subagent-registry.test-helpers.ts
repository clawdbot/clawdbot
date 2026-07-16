export * from "./subagent-registry.js";

import { collectSessionMaintenancePreserveKeys } from "../config/sessions/store-maintenance-preserve.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.shared.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import {
  countPendingDescendantRunsExcludingRunFromRuns,
  isSubagentSessionRunActiveFromRuns,
  listRunsForRequesterFromRuns,
  resolveRequesterForChildSessionFromRuns,
  shouldIgnorePostCompletionAnnounceForSessionFromRuns,
} from "./subagent-registry-queries.js";
import { getSubagentRunsSnapshotForRead } from "./subagent-registry-state.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
export {
  getSubagentSessionRuntimeMs,
  getSubagentSessionStartedAt,
  resolveSubagentSessionStatus,
} from "./subagent-session-metrics.js";

type RegistryTestApi = {
  addSubagentRunForTests(entry: SubagentRunRecord): void;
  finalizeInterruptedSubagentRun(params: {
    runId: string;
    error: string;
    endedAt?: number;
  }): Promise<number>;
  releaseSubagentRun(runId: string): void;
  resetSubagentRegistryForTests(opts?: { persist?: boolean }): void;
  testing: {
    sweepOnceForTests(): Promise<void>;
    runSweeperTickForTests(): Promise<void>;
    setDepsForTest(overrides?: Partial<RegistryDeps>): void;
  };
};

type RegistryDeps = {
  callGateway: typeof import("../gateway/call.js").callGateway;
  getGatewayRecoveryRuntime: () =>
    | import("../gateway/server-instance-runtime.types.js").GatewayRecoveryRuntime
    | undefined;
  captureSubagentCompletionReply: typeof import("./subagent-announce.js").captureSubagentCompletionReply;
  cleanupBrowserSessionsForLifecycleEnd: typeof import("../browser-lifecycle-cleanup.js").cleanupBrowserSessionsForLifecycleEnd;
  getSubagentRunsSnapshotForRead: typeof import("./subagent-registry-state.js").getSubagentRunsSnapshotForRead;
  getRuntimeConfig: typeof import("../config/config.js").getRuntimeConfig;
  onAgentEvent: typeof import("../infra/agent-events.js").onAgentEvent;
  persistSubagentRunsToDisk: typeof import("./subagent-registry-state.js").persistSubagentRunsToDisk;
  persistSubagentRunsToDiskOrThrow: typeof import("./subagent-registry-state.js").persistSubagentRunsToDiskOrThrow;
  resolveAgentTimeoutMs: typeof import("./timeout.js").resolveAgentTimeoutMs;
  restoreSubagentRunsFromDisk: typeof import("./subagent-registry-state.js").restoreSubagentRunsFromDisk;
  runSubagentAnnounceFlow: typeof import("./subagent-announce.js").runSubagentAnnounceFlow;
  ensureContextEnginesInitialized?: () => void;
  ensureRuntimePluginsLoaded?: typeof import("./runtime-plugins.js").ensureRuntimePluginsLoaded;
  resolveContextEngine?: typeof import("../context-engine/registry.js").resolveContextEngine;
};

function getRegistryTestApi(): RegistryTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.subagentRegistryTestApi")
  ] as RegistryTestApi;
}

export function resetSubagentRegistryForTests(opts?: { persist?: boolean }) {
  getRegistryTestApi().resetSubagentRegistryForTests(opts);
}

export function addSubagentRunForTests(entry: SubagentRunRecord) {
  getRegistryTestApi().addSubagentRunForTests(entry);
}

export function releaseSubagentRun(runId: string) {
  getRegistryTestApi().releaseSubagentRun(runId);
}

export async function finalizeInterruptedSubagentRun(params: {
  runId: string;
  error: string;
  endedAt?: number;
}) {
  return await getRegistryTestApi().finalizeInterruptedSubagentRun(params);
}

export const testing = {
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

export function isSubagentSessionRunActive(childSessionKey: string) {
  return isSubagentSessionRunActiveFromRuns(subagentRuns, childSessionKey);
}

export function listSubagentRunsForRequester(
  requesterSessionKey: string,
  options?: { requesterRunId?: string },
) {
  return listRunsForRequesterFromRuns(subagentRuns, requesterSessionKey, options);
}

export function resolveRequesterForChildSession(childSessionKey: string) {
  const resolved = resolveRequesterForChildSessionFromRuns(
    getSubagentRunsSnapshotForRead(subagentRuns),
    childSessionKey,
  );
  if (!resolved) {
    return null;
  }
  return {
    requesterSessionKey: resolved.requesterSessionKey,
    requesterOrigin: normalizeDeliveryContext(resolved.requesterOrigin),
  };
}

export function shouldIgnorePostCompletionAnnounceForSession(childSessionKey: string) {
  return shouldIgnorePostCompletionAnnounceForSessionFromRuns(
    getSubagentRunsSnapshotForRead(subagentRuns),
    childSessionKey,
  );
}

export function listSessionMaintenanceProtectedSubagentSessionKeys() {
  return [...(collectSessionMaintenancePreserveKeys() ?? [])];
}
