import type { cleanupBrowserSessionsForLifecycleEnd } from "../browser-lifecycle-cleanup.js";
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ResolveContextEngineOptions } from "../context-engine/registry.js";
import type { ContextEngine } from "../context-engine/types.js";
import { callGateway } from "../gateway/call.js";
import type { GatewayRecoveryRuntime } from "../gateway/server-instance-runtime.types.js";
import { getGatewayRecoveryRuntime } from "../gateway/server-recovery-runtime-context.js";
import { onAgentEvent, type AgentEventPayload } from "../infra/agent-events.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { createLazyImportLoader, createLazyPromiseLoader } from "../shared/lazy-promise.js";
import { importRuntimeModule } from "../shared/runtime-import.js";
import {
  getSubagentRunsSnapshotForChildSession,
  getSubagentRunsSnapshotForController,
  getSubagentRunsSnapshotForRead,
  persistSubagentRunsToDisk,
  persistSubagentRunsToDiskOrThrow,
  restoreSubagentRunsFromDisk,
} from "./subagent-registry-state.js";
import { resolveAgentTimeoutMs } from "./timeout.js";

type SubagentAnnounceModule = Pick<
  typeof import("./subagent-announce.js"),
  "captureSubagentCompletionReply" | "runSubagentAnnounceFlow"
>;
type RequesterSettleWakeModule = Pick<
  typeof import("./subagent-announce.requester-settle-wake.js"),
  "maybeWakeRequesterAfterAllChildrenSettled"
>;
type BrowserCleanupModule = Pick<
  typeof import("../browser-lifecycle-cleanup.js"),
  "cleanupBrowserSessionsForLifecycleEnd"
>;

export type SubagentRegistryDeps = {
  callGateway: typeof callGateway;
  getGatewayRecoveryRuntime: () => GatewayRecoveryRuntime | undefined;
  captureSubagentCompletionReply: SubagentAnnounceModule["captureSubagentCompletionReply"];
  cleanupBrowserSessionsForLifecycleEnd: typeof cleanupBrowserSessionsForLifecycleEnd;
  getSubagentRunsSnapshotForChildSession: typeof getSubagentRunsSnapshotForChildSession;
  getSubagentRunsSnapshotForController: typeof getSubagentRunsSnapshotForController;
  getSubagentRunsSnapshotForRead: typeof getSubagentRunsSnapshotForRead;
  getRuntimeConfig: typeof getRuntimeConfig;
  onAgentEvent: (listener: (event: AgentEventPayload) => void) => () => void;
  persistSubagentRunsToDisk: typeof persistSubagentRunsToDisk;
  persistSubagentRunsToDiskOrThrow: typeof persistSubagentRunsToDiskOrThrow;
  resolveAgentTimeoutMs: typeof resolveAgentTimeoutMs;
  restoreSubagentRunsFromDisk: typeof restoreSubagentRunsFromDisk;
  runSubagentAnnounceFlow: SubagentAnnounceModule["runSubagentAnnounceFlow"];
  maybeWakeRequesterAfterAllChildrenSettled: RequesterSettleWakeModule["maybeWakeRequesterAfterAllChildrenSettled"];
  ensureContextEnginesInitialized?: () => void;
  loadAgentRuntimePluginRegistryHandle?: (params: {
    config: OpenClawConfig;
    workspaceDir?: string;
    allowGatewaySubagentBinding?: boolean;
  }) => PluginRegistry | undefined;
  resolveContextEngine?: (
    cfg?: OpenClawConfig,
    options?: ResolveContextEngineOptions,
  ) => Promise<ContextEngine>;
};

const subagentAnnounceLoader = createLazyImportLoader<SubagentAnnounceModule>(
  () => import("./subagent-announce.js"),
);
const browserCleanupLoader = createLazyImportLoader<BrowserCleanupModule>(
  () => import("../browser-lifecycle-cleanup.js"),
);

async function loadSubagentAnnounceModule(): Promise<SubagentAnnounceModule> {
  return await subagentAnnounceLoader.load();
}

async function loadCleanupBrowserSessionsForLifecycleEnd(): Promise<
  BrowserCleanupModule["cleanupBrowserSessionsForLifecycleEnd"]
> {
  return (await browserCleanupLoader.load()).cleanupBrowserSessionsForLifecycleEnd;
}

const defaultSubagentRegistryDeps: SubagentRegistryDeps = {
  callGateway,
  getGatewayRecoveryRuntime,
  captureSubagentCompletionReply: async (sessionKey, options) =>
    (await loadSubagentAnnounceModule()).captureSubagentCompletionReply(sessionKey, options),
  cleanupBrowserSessionsForLifecycleEnd: async (params) =>
    (await loadCleanupBrowserSessionsForLifecycleEnd())(params),
  getSubagentRunsSnapshotForChildSession,
  getSubagentRunsSnapshotForController,
  getSubagentRunsSnapshotForRead,
  getRuntimeConfig,
  onAgentEvent,
  persistSubagentRunsToDisk,
  persistSubagentRunsToDiskOrThrow,
  resolveAgentTimeoutMs,
  restoreSubagentRunsFromDisk,
  runSubagentAnnounceFlow: async (params) =>
    (await loadSubagentAnnounceModule()).runSubagentAnnounceFlow(params),
  maybeWakeRequesterAfterAllChildrenSettled: async (params) =>
    (
      await import("./subagent-announce.requester-settle-wake.js")
    ).maybeWakeRequesterAfterAllChildrenSettled(params),
};

export let subagentRegistryDeps: SubagentRegistryDeps = defaultSubagentRegistryDeps;
type SubagentRegistryRuntimeModule = {
  ensureContextEnginesInitialized: () => void;
  resolveContextEngine: (
    cfg?: OpenClawConfig,
    options?: ResolveContextEngineOptions,
  ) => Promise<ContextEngine>;
};

const SUBAGENT_REGISTRY_RUNTIME_SPEC = ["./subagent-registry.runtime", ".js"] as const;

// All three capabilities belong to the same lazy runtime module and lifecycle.
const subagentRegistryRuntimeLoader = createLazyPromiseLoader(() =>
  importRuntimeModule<SubagentRegistryRuntimeModule>(
    import.meta.url,
    SUBAGENT_REGISTRY_RUNTIME_SPEC,
  ),
);
const subagentRegistryPluginRuntimeLoader = createLazyPromiseLoader(
  () => import("./runtime-plugins.js"),
);

export async function loadSubagentRegistryPluginRuntimeHandle(params: {
  config: OpenClawConfig;
  workspaceDir?: string;
  allowGatewaySubagentBinding?: boolean;
}): Promise<PluginRegistry | undefined> {
  const configuredLoader = subagentRegistryDeps.loadAgentRuntimePluginRegistryHandle;
  if (configuredLoader) {
    return configuredLoader(params);
  }
  return (await subagentRegistryPluginRuntimeLoader.load()).loadAgentRuntimePluginRegistryHandle(
    params,
  );
}

export async function resolveSubagentRegistryContextEngine(
  cfg: OpenClawConfig,
  options?: ResolveContextEngineOptions,
) {
  const runtime = await subagentRegistryRuntimeLoader.load();
  const ensureContextEnginesInitialized =
    subagentRegistryDeps.ensureContextEnginesInitialized ?? runtime.ensureContextEnginesInitialized;
  const resolveContextEngine =
    subagentRegistryDeps.resolveContextEngine ?? runtime.resolveContextEngine;
  ensureContextEnginesInitialized();
  return await resolveContextEngine(cfg, options);
}

export function setSubagentRegistryDepsForTest(overrides?: Partial<SubagentRegistryDeps>) {
  subagentRegistryDeps = overrides
    ? { ...defaultSubagentRegistryDeps, ...overrides }
    : defaultSubagentRegistryDeps;
}

export function resetSubagentRegistryRuntimeLoadersForTests() {
  subagentRegistryRuntimeLoader.clear();
  subagentRegistryPluginRuntimeLoader.clear();
  subagentAnnounceLoader.clear();
  browserCleanupLoader.clear();
}
