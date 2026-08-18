import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { hasOperatorReadAccess } from "../../app/operator-access.ts";
import { canCallGatewayMethod, isGatewayMethodAdvertised } from "../gateway-methods.ts";
import { createAppliedConfigRefreshController } from "./applied-refresh.ts";
import { clearConfigDraftTracking } from "./config-draft-model.ts";
import {
  loadConfig,
  loadConfigSchema,
  lookupConfigSchemaPath,
  openConfigFile,
  type ConfigPatchBuilder,
  type ConfigWriteCoordinator,
  type ConfigMethod,
  type ConfigPatchOptions,
  type RuntimeConfigDispatchOptions,
  type RuntimeConfigExternalMutationOptions,
  type RuntimeConfigExternalMutationResult,
} from "./config-gateway-operations.ts";
import {
  agentConfigEntry,
  clearConfigRequestVersions,
  createInitialConfigState,
  type AgentConfigEntryTarget,
  type LoadConfigOptions,
  type RuntimeConfigGateway,
  type RuntimeConfigState,
} from "./config-state-model.ts";
import { createConfigWriteCoordinator } from "./config-write-coordinator.ts";

export type RuntimeConfigCapability = {
  readonly state: RuntimeConfigState;
  readonly canSet?: boolean;
  readonly canApply?: boolean;
  readonly canPatch?: boolean;
  readonly canOpenFile?: boolean;
  ensureLoaded: () => Promise<void>;
  ensureSchemaLoaded: () => Promise<void>;
  refresh: (options?: LoadConfigOptions) => Promise<void>;
  refreshSchema: () => Promise<void>;
  patchForm: (path: Array<string | number>, value: unknown) => void;
  removeFormValue: (path: Array<string | number>) => void;
  setRaw: (value: string) => void;
  resetDraft: () => void;
  /** Discards pending edits: reloads from disk when connected, else resets locally. */
  discardDraft: () => Promise<void>;
  /** Pauses/resumes all config writes (autosave + manual) while e.g. the app updater runs. */
  setWritesSuspended: (suspended: boolean) => void;
  /** Resolves once no config write is in flight (used as an updater barrier). */
  waitForPendingWrites: () => Promise<void>;
  save: (options?: RuntimeConfigDispatchOptions) => Promise<boolean>;
  apply: () => Promise<boolean>;
  openFile: () => Promise<void>;
  /** Resolves the authored keyed entry; ensure returns a writable target without mutating. */
  agentEntry: (agentId: string, options?: { ensure?: boolean }) => AgentConfigEntryTarget | null;
  stageDefaultAgent: (agentId: string) => boolean;
  patch: (options: ConfigPatchOptions) => Promise<boolean>;
  patchFromSnapshot: (build: ConfigPatchBuilder) => Promise<boolean>;
  /**
   * Serializes a config-writing RPC behind this capability's pending draft,
   * then refreshes the authoritative snapshot before resolving.
   */
  runExternalMutation: <T>(
    task: (client: GatewayBrowserClient) => Promise<T>,
    options?: RuntimeConfigExternalMutationOptions,
  ) => Promise<RuntimeConfigExternalMutationResult<T>>;
  lookupSchemaPath: (path: string) => Promise<unknown>;
  subscribe: (listener: (state: RuntimeConfigState) => void) => () => void;
  dispose: () => void;
};

export function createRuntimeConfigCapability(
  gateway: RuntimeConfigGateway,
): RuntimeConfigCapability {
  const state = createInitialConfigState(gateway.snapshot);
  const listeners = new Set<(state: RuntimeConfigState) => void>();
  let configLoad: Promise<void> | null = null;
  let schemaLoad: Promise<void> | null = null;
  let disposed = false;

  const canCallConfigMethod = (
    method: ConfigMethod,
    options?: { requireAdvertisement?: boolean },
  ) =>
    canCallGatewayMethod(
      {
        client: gateway.snapshot.client,
        hello: gateway.snapshot.hello ?? null,
        phase: gateway.snapshot.phase,
      },
      method,
      method === "config.schema" ? "operator.read" : "operator.admin",
      options,
    );
  const publish = () => {
    if (disposed) {
      return;
    }
    for (const listener of listeners) {
      listener(state);
    }
  };
  const run = async <T>(task: () => Promise<T>): Promise<T> => {
    try {
      const result = task();
      // Async config owners mutate their busy flag before the first await.
      // Publish that transition so editors can lock before accepting more input.
      publish();
      return await result;
    } finally {
      publish();
    }
  };
  const mutate = (task: () => void) => {
    task();
    publish();
  };
  const trackLoad = (key: "config" | "schema", promise: Promise<unknown>): Promise<void> => {
    const next = promise
      .then(() => undefined)
      .finally(() => {
        if (key === "config" && configLoad === next) {
          configLoad = null;
        } else if (key === "schema" && schemaLoad === next) {
          schemaLoad = null;
        }
      });
    if (key === "config") {
      configLoad = next;
    } else {
      schemaLoad = next;
    }
    return next;
  };
  const loadOnce = (key: "config" | "schema", task: () => Promise<unknown>): Promise<void> => {
    const current = key === "config" ? configLoad : schemaLoad;
    return current ?? trackLoad(key, run(task));
  };

  const appliedRefresh = createAppliedConfigRefreshController({
    shouldRefresh: () =>
      !disposed &&
      state.connected &&
      state.configNeedsApply &&
      state.configSnapshot?.appliedConfigHash !== undefined,
    refresh: (isCurrent) => loadOnce("config", () => loadConfig(state, {}, isCurrent)),
  });
  const refreshConnectionState = () => {
    const config = run(() => loadConfig(state));
    void trackLoad("config", config);
    if (state.configSchemaVersion !== null && canLoadConfigSchema()) {
      void trackLoad(
        "schema",
        run(() => loadConfigSchema(state)),
      );
    }
    return config;
  };

  const writes: ConfigWriteCoordinator = createConfigWriteCoordinator({
    state,
    gateway,
    publish,
    run,
    mutate,
    trackLoad,
    resetLoads: () => {
      configLoad = null;
      schemaLoad = null;
    },
    resetConfigLoad: () => {
      configLoad = null;
    },
    refreshConnectionState,
    canCallConfigMethod,
    cancelAppliedRefresh: appliedRefresh.cancel,
    reconcileAppliedRefresh: appliedRefresh.reconcile,
    disposeAppliedRefresh: appliedRefresh.dispose,
    isDisposed: () => disposed,
  });

  const ensureLoaded = async () => {
    if (!state.configSnapshot) {
      await loadOnce("config", () => loadConfig(state));
    }
    appliedRefresh.reconcile();
  };
  // Schema reads fail open like operator-access: only a definitive denial
  // (method advertised absent, or advertised scopes without read) skips the
  // load, so legacy scope-less gateways keep schema-driven settings pages.
  const canLoadConfigSchema = () => {
    const snapshot = gateway.snapshot;
    if (!snapshot.client || snapshot.phase !== "connected") {
      return false;
    }
    if (isGatewayMethodAdvertised(snapshot, "config.schema") === false) {
      return false;
    }
    return hasOperatorReadAccess(snapshot.hello?.auth ?? null);
  };
  const ensureSchemaLoaded = () =>
    state.configSchema || !canLoadConfigSchema()
      ? Promise.resolve()
      : loadOnce("schema", () => loadConfigSchema(state));

  return {
    get state() {
      return state;
    },
    get canSet() {
      return canCallConfigMethod("config.set");
    },
    get canApply() {
      return canCallConfigMethod("config.apply");
    },
    get canPatch() {
      return canCallConfigMethod("config.patch");
    },
    get canOpenFile() {
      return canCallConfigMethod("config.openFile", { requireAdvertisement: false });
    },
    ensureLoaded,
    ensureSchemaLoaded,
    refresh: async (options) => {
      if (options?.discardPendingChanges) {
        await writes.prepareDiscard();
      }
      appliedRefresh.cancel();
      try {
        await trackLoad(
          "config",
          run(() => loadConfig(state, options)),
        );
      } finally {
        appliedRefresh.reconcile();
      }
    },
    refreshSchema: () =>
      trackLoad(
        "schema",
        run(() => loadConfigSchema(state)),
      ),
    patchForm: writes.patchForm,
    removeFormValue: writes.removeFormValue,
    setRaw: writes.setRaw,
    resetDraft: writes.resetDraft,
    discardDraft: writes.discardDraft,
    setWritesSuspended: writes.setWritesSuspended,
    waitForPendingWrites: writes.waitForPendingWrites,
    save: writes.save,
    apply: writes.apply,
    openFile: () =>
      canCallConfigMethod("config.openFile", { requireAdvertisement: false })
        ? run(() => openConfigFile(state))
        : Promise.resolve(),
    agentEntry: (agentId, options) => agentConfigEntry(state, agentId, options),
    stageDefaultAgent: writes.stageDefaultAgent,
    patch: writes.patch,
    patchFromSnapshot: writes.patchFromSnapshot,
    runExternalMutation: writes.runExternalMutation,
    lookupSchemaPath: (path) => run(() => lookupConfigSchemaPath(state, path)),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      disposed = true;
      writes.dispose();
      listeners.clear();
      clearConfigRequestVersions(state);
      clearConfigDraftTracking(state);
    },
  };
}
