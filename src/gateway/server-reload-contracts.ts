import type { CliDeps } from "../cli/deps.types.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";
import type { HeartbeatRunner } from "../infra/heartbeat-runner.js";
import type { GatewayRestartEmitter } from "../infra/restart.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import type { ChannelHealthMonitor } from "./channel-health-monitor.js";
import type { ChannelKind } from "./config-reload-plan.js";
import type { GatewayReloadPlan } from "./config-reload.js";
import type { GatewayCronReconciliation } from "./server-cron-reconciled.js";
import type { GatewayCronState } from "./server-cron.js";
import type { GatewayConfigReloaderHandle } from "./server-runtime-handles.js";
import type { GatewayChannelManager } from "./server-runtime-services.js";
import type {
  SharedGatewayAuthClient,
  SharedGatewaySessionGenerationState,
} from "./server-shared-auth-generation.js";
import type { ActivateRuntimeSecrets } from "./server-startup-config.js";
import type { HookClientIpConfig } from "./server/hooks-request-handler.js";

let currentReloadGeneration = 0;
let abortGeneration: number | undefined;

export function nextGatewayReloadGeneration(): number {
  return ++currentReloadGeneration;
}

export function isCurrentGatewayReloadGeneration(generation: number): boolean {
  return generation === currentReloadGeneration;
}

export function isGatewayReloadGenerationAborted(generation: number): boolean {
  return abortGeneration !== undefined && generation <= abortGeneration;
}

/** Signal any in-progress deferred channel reload to abort immediately. */
export function abortPendingChannelReloads(): void {
  abortGeneration = currentReloadGeneration;
}

export type RuntimeSecretsPreflightParams = Omit<
  Parameters<ActivateRuntimeSecrets>[1],
  "activate" | "canPublishFailureAsDegraded"
>;

export type CurrentRuntimeSecretsPreparation = {
  snapshot: import("../secrets/runtime-state.js").PreparedSecretsRuntimeSnapshot;
  expectedRevision: number;
};

type GatewayHotReloadState = {
  hooksConfig: ReturnType<typeof import("./hooks.js").resolveHooksConfig>;
  hookClientIpConfig: HookClientIpConfig;
  heartbeatRunner: HeartbeatRunner;
  cronState: GatewayCronState;
  channelHealthMonitor: ChannelHealthMonitor | null;
};

type GatewayReloadLog = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error?: (msg: string) => void;
};

export type GatewayGmailRestartAbortController = {
  abort: () => void;
  signal: AbortSignal;
};

export type GatewayHotReloadPublication = {
  publish: (commit: () => Promise<void>, isCommitted: () => boolean) => Promise<void>;
  isCurrent: () => boolean;
  sourceConfig: OpenClawConfig;
  prepareRestartRuntimeConfig?: () => Promise<OpenClawConfig>;
  runtimeEnv?: NodeJS.ProcessEnv;
};

export type GatewayRestartTransactionState = "pending" | "committed" | "rejected";

export type GatewayRestartTransactionResult = {
  status: "accepted" | "recovery-pending";
  settle: (state: Exclude<GatewayRestartTransactionState, "pending">) => void;
};

export type GatewayRestartRequestOptions = {
  retainDebtAcrossConfigChanges?: boolean;
  prepareRuntimeConfig?: () => Promise<OpenClawConfig>;
  debtConfig?: OpenClawConfig;
};

export type AcceptedRestartTarget = {
  runtimeConfig: OpenClawConfig;
  sourceConfig: OpenClawConfig;
  prepareRuntimeConfig: () => Promise<OpenClawConfig>;
};

export type AcceptedRestartTargetOwnership = {
  reject: () => void;
};

export class GatewayHotReloadCancelledError extends Error {
  constructor() {
    super("config hot reload cancelled by config supersession or in-process restart");
    this.name = "GatewayHotReloadCancelledError";
  }
}

export class GatewayHotReloadRecoveryError extends Error {
  constructor(surface: string) {
    super(`config hot reload committed but could not schedule recovery for ${surface}`);
    this.name = "GatewayHotReloadRecoveryError";
  }
}

export class GatewayReloadRequiresRecoveryOwnerError extends Error {
  constructor(surface: string) {
    super(`config reload requires a managed gateway restart owner for ${surface}`);
    this.name = "GatewayReloadRequiresRecoveryOwnerError";
  }
}

export class GatewayHotReloadStaleSecretsError extends Error {
  constructor() {
    super("runtime secrets changed while config hot reload was deferred");
    this.name = "GatewayHotReloadStaleSecretsError";
  }
}

export class GatewayConfigReloadSupersededError extends Error {
  constructor() {
    super("config reload superseded by a newer runtime config source");
    this.name = "GatewayConfigReloadSupersededError";
  }
}

export function assertReloadPublicationCurrent(
  publicationCurrent: boolean,
  restartStopped: boolean,
): void {
  if (!publicationCurrent) {
    throw new GatewayConfigReloadSupersededError();
  }
  if (restartStopped) {
    throw new GatewayHotReloadCancelledError();
  }
}

export type GatewayPluginReloadResult = {
  restartChannels: ReadonlySet<ChannelKind>;
  activeChannels: ReadonlySet<ChannelKind>;
  /** Set when the reload was cancelled mid-flight (e.g. by an in-process restart). */
  cancelled?: boolean;
};

export type GatewayReloadHandlerParams = {
  deps: CliDeps;
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
  /** Kept across cron rebuilds so a hot reload does not drop scheduler gateway context. */
  resolveGatewayContext?: () =>
    | import("./server-methods/types.js").GatewayRequestContext
    | undefined;
  getState: () => GatewayHotReloadState;
  setState: (state: GatewayHotReloadState) => void;
  getPluginMetadataSnapshot?: () => PluginMetadataSnapshot | undefined;
  startChannel: GatewayChannelManager["startChannel"];
  stopChannel: GatewayChannelManager["stopChannel"];
  pruneInactiveChannelAccountState: (activeChannelIds: ReadonlySet<ChannelKind>) => void;
  getChannelAutostartSuppression?: GatewayChannelManager["getAutostartSuppression"];
  stopPostReadySidecars?: () => Promise<void> | void;
  reloadPlugins: (params: {
    nextConfig: OpenClawConfig;
    sourceConfig: OpenClawConfig;
    changedPaths: readonly string[];
    beforeReplace: (
      channels: ReadonlySet<ChannelKind>,
      accounts?: ReadonlyMap<ChannelKind, ReadonlySet<string>>,
    ) => Promise<void>;
    commitRuntime: (onCommit?: () => void) => Promise<void>;
    onReplacementTeardownFailure: (error: unknown) => void;
    env: NodeJS.ProcessEnv;
    isAborted?: () => boolean;
  }) => Promise<GatewayPluginReloadResult>;
  logHooks: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  logChannels: { info: (msg: string) => void; error: (msg: string) => void };
  logCron: { error: (msg: string) => void };
  logReload: GatewayReloadLog;
  cronReconciliation: GatewayCronReconciliation;
  createHealthMonitor: (config: OpenClawConfig) => ChannelHealthMonitor | null;
  createGmailRestartAbortController?: () => GatewayGmailRestartAbortController;
  clearGmailRestartAbortController?: (controller: GatewayGmailRestartAbortController) => void;
  onCronRestart?: () => void;
  requestRecoveryRestart?: GatewayRestartEmitter;
  restartRecoveryAvailable?: boolean;
  /** Revalidate successor-owned startup state before the current listener is closed. */
  assertRestartReady?: () => Promise<void> | void;
};

export type ManagedGatewayConfigReloaderParams = Omit<
  GatewayReloadHandlerParams,
  "assertRestartReady" | "createHealthMonitor" | "logReload" | "pruneInactiveChannelAccountState"
> & {
  configRevisionProjector: import("./config-revision-token.js").GatewayConfigRevisionProjector;
  minimalTestGateway: boolean;
  initialConfig: OpenClawConfig;
  initialCompareConfig?: OpenClawConfig;
  initialSnapshotRawHash: string | null;
  initialAuthoredConfig: unknown;
  initialIncludedPaths?: readonly string[];
  initialSnapshotValid: boolean;
  initialSnapshotIssues: ConfigFileSnapshot["issues"];
  initialInternalWriteHash: string | null;
  watchPath: string;
  readSnapshot: typeof import("../config/io.js").readConfigFileSnapshotForRuntimeTransaction;
  promoteSnapshot: typeof import("../config/config.js").promoteConfigSnapshotToLastKnownGood;
  subscribeToWrites: typeof import("../config/config.js").registerConfigWriteListener;
  logReload: GatewayReloadLog & { error: (msg: string) => void };
  channelManager: GatewayChannelManager & {
    pruneInactiveChannelAccountState: GatewayReloadHandlerParams["pruneInactiveChannelAccountState"];
  };
  activateRuntimeSecrets: ActivateRuntimeSecrets;
  /** Applies one immutable effective config/compare snapshot before reload planning. */
  prepareConfigCandidate?: (params: {
    runtimeConfig: OpenClawConfig;
    sourceConfig: OpenClawConfig;
  }) => {
    runtimeConfig: OpenClawConfig;
    compareConfig: OpenClawConfig;
    reapplyRuntimeOverlays?: (config: OpenClawConfig) => OpenClawConfig;
    reapplyCompareOverlays?: (config: OpenClawConfig) => OpenClawConfig;
  };
  /** Reapplies fixed process-lifetime overlays before secrets preparation. */
  applyRuntimeConfigOverrides?: (config: OpenClawConfig) => OpenClawConfig;
  resolveSharedGatewaySessionGenerationForConfig: (config: OpenClawConfig) => string | undefined;
  sharedGatewaySessionGenerationState: SharedGatewaySessionGenerationState;
  clients: Iterable<SharedGatewayAuthClient>;
  prepareTerminalConfig: (plan: GatewayReloadPlan, nextConfig: OpenClawConfig) => void;
  reconcileTerminalSessions: (plan: GatewayReloadPlan, nextConfig: OpenClawConfig) => void;
  commitTerminalConfig: (nextConfig: OpenClawConfig) => void;
  acceptTerminalConfig: (options: { retireRejectedRestart: boolean }) => void;
};

export type ManagedGatewayConfigReloaderHandle = GatewayConfigReloaderHandle;
