/** Parent-owned native auth preparation and compute-worker lifetime for provider warmup. */
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { WorkerTaskError, WorkerTaskPool } from "../infra/worker-task-pool.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { captureProviderSyntheticAuthFacts } from "../plugins/provider-runtime.js";
import type { PreparedSyntheticAuthFacts } from "../plugins/provider-synthetic-auth.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { listManifestSyntheticAuthProviderRefs } from "../plugins/synthetic-auth.runtime.js";
import { listAgentIds, resolveAgentWorkspaceDir } from "./agent-scope-config.js";
import type { AuthProfileStore } from "./auth-profiles.js";
import type { RuntimeProviderAuthLookup } from "./model-auth-runtime.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import {
  clearCurrentProviderAuthWarmWorker,
  setCurrentProviderAuthWarmWorker,
  type ProviderAuthWarmSnapshot,
} from "./model-provider-auth-state.js";
import { prepareOwnedPluginLoadContext } from "./prepared-model-runtime.plugin-context.js";

export type ProviderAuthWarmWorkerResult =
  | {
      status: "ok";
      snapshot: ProviderAuthWarmSnapshot;
    }
  | {
      status: "failed";
      error: string;
    };

export type ProviderAuthWarmRuntimeAuthStore = {
  agentDir?: string;
  store: AuthProfileStore;
};

export type ProviderAuthWarmRuntimeAuthLookup = {
  agentId: string;
  lookup: RuntimeProviderAuthLookup;
};

export type ProviderAuthWarmSyntheticAuthScope = {
  agentId: string;
  workspaceDir: string;
  metadataSnapshot: Omit<PluginMetadataSnapshot, "normalizePluginId">;
  facts: PreparedSyntheticAuthFacts;
  modelCatalog?: ModelCatalogSnapshot;
};

export type ProviderAuthWarmWorkerInput = {
  cfg: OpenClawConfig;
  runtimeAuthStores?: ProviderAuthWarmRuntimeAuthStore[];
  runtimeAuthLookups?: ProviderAuthWarmRuntimeAuthLookup[];
  omitFalseProviderAuth?: boolean;
  syntheticAuth: ProviderAuthWarmSyntheticAuthScope[];
};

export type ProviderAuthWarmWorkerRunner = (
  params: Omit<ProviderAuthWarmWorkerInput, "syntheticAuth"> & {
    timeoutMs: number;
    isCancelled: () => boolean;
    workerUrl?: URL;
  },
) => Promise<ProviderAuthWarmSnapshot>;

const PROVIDER_AUTH_WARM_CANCEL_POLL_MS = 25;

function isProviderAuthWarmSnapshot(value: unknown): value is ProviderAuthWarmSnapshot {
  if (!isRecord(value) || !Array.isArray(value.agents)) {
    return false;
  }
  return value.agents.every(
    (agent) =>
      isRecord(agent) &&
      typeof agent.agentId === "string" &&
      typeof agent.configFingerprint === "string" &&
      Array.isArray(agent.providers) &&
      agent.providers.every(
        (entry: unknown) =>
          Array.isArray(entry) &&
          entry.length === 2 &&
          typeof entry[0] === "string" &&
          typeof entry[1] === "boolean",
      ),
  );
}

function isProviderAuthWarmWorkerResult(value: unknown): value is ProviderAuthWarmWorkerResult {
  if (!isRecord(value)) {
    return false;
  }
  if (value.status === "failed") {
    return typeof value.error === "string";
  }
  return value.status === "ok" && isProviderAuthWarmSnapshot(value.snapshot);
}

export const runProviderAuthWarmWorker: ProviderAuthWarmWorkerRunner = async (params) => {
  const workerUrl =
    params.workerUrl ??
    resolveRuntimeWorkerUrl({
      currentModuleUrl: import.meta.url,
      sourceWorkerName: "model-provider-auth.worker",
      distWorkerPath: "agents/model-provider-auth.worker.js",
    });
  // Auth preparation owns process-local catalog caches, so each warm generation gets its own pool.
  const env = { ...process.env };
  const pool = new WorkerTaskPool<ProviderAuthWarmWorkerInput, ProviderAuthWarmWorkerResult>({
    workerUrl,
    maxWorkers: 1,
    workerOptions: { env },
  });
  const handle = new AbortController();
  const deadline = new AbortController();
  const signal = AbortSignal.any([handle.signal, deadline.signal]);
  const timeout = setTimeout(
    () => deadline.abort(new WorkerTaskError("worker task timed out", "timeout")),
    resolveTimerTimeoutMs(params.timeoutMs, 60_000),
  );
  setCurrentProviderAuthWarmWorker(handle);
  const cancelTimer = setInterval(() => {
    if (params.isCancelled()) {
      handle.abort();
    }
  }, PROVIDER_AUTH_WARM_CANCEL_POLL_MS);
  cancelTimer.unref();
  try {
    if (params.isCancelled()) {
      handle.abort();
    }
    const { getPreparedModelCatalogOwnerSnapshot } = await import("./prepared-model-catalog.js");
    const syntheticAuth: ProviderAuthWarmSyntheticAuthScope[] = [];
    // Native probes finish in the parent; the warm cache and lookups use configured workspaces.
    for (const agentId of listAgentIds(params.cfg)) {
      if (params.isCancelled()) {
        handle.abort();
      }
      signal.throwIfAborted();
      const workspaceDir = resolveAgentWorkspaceDir(params.cfg, agentId);
      const owner = getPreparedModelCatalogOwnerSnapshot({
        config: params.cfg,
        agentId,
        workspaceDir,
      });
      const metadata =
        owner?.metadataSnapshot ??
        prepareOwnedPluginLoadContext({ config: params.cfg, workspaceDir }, env, undefined);
      const facts = await withPluginRuntimeGenerationScope(
        { metadataSnapshot: metadata, pluginRegistry: owner?.pluginRegistry },
        () =>
          captureProviderSyntheticAuthFacts({
            config: params.cfg,
            env,
            workspaceDir,
            providerRefs: [
              ...listManifestSyntheticAuthProviderRefs(metadata.index),
              ...Object.keys(params.cfg.models?.providers ?? {}),
            ],
            signal,
          }),
      );
      signal.throwIfAborted();
      const { normalizePluginId: _normalizePluginId, ...metadataSnapshot } = metadata;
      syntheticAuth.push({
        agentId,
        workspaceDir,
        metadataSnapshot,
        ...(owner ? { modelCatalog: owner.modelCatalog } : {}),
        facts: facts.map((fact) => ({
          providerRef: fact.providerRef,
          result: fact.result?.apiKey.trim()
            ? {
                apiKey: "synthetic-auth-present",
                source: "prepared synthetic auth",
                mode: fact.result.mode,
                ...(fact.result.expiresAt === undefined
                  ? {}
                  : { expiresAt: fact.result.expiresAt }),
              }
            : null,
        })),
      });
    }
    const message = await pool.run(
      {
        cfg: params.cfg,
        syntheticAuth,
        ...(params.runtimeAuthStores?.length
          ? { runtimeAuthStores: params.runtimeAuthStores }
          : {}),
        ...(params.runtimeAuthLookups?.length
          ? { runtimeAuthLookups: params.runtimeAuthLookups }
          : {}),
        ...(params.omitFalseProviderAuth ? { omitFalseProviderAuth: true } : {}),
      },
      { timeoutMs: params.timeoutMs, signal },
    );
    if (handle.signal.aborted || params.isCancelled()) {
      return { agents: [] };
    }
    if (!isProviderAuthWarmWorkerResult(message)) {
      throw new Error("invalid provider auth warm worker response");
    }
    if (message.status === "failed") {
      throw new Error(message.error);
    }
    return message.snapshot;
  } catch (error) {
    if (handle.signal.aborted) {
      return { agents: [] };
    }
    if (error instanceof WorkerTaskError && error.code === "timeout") {
      throw new Error("provider auth warm worker timed out", { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    clearInterval(cancelTimer);
    clearCurrentProviderAuthWarmWorker(handle);
    await pool.close();
  }
};
