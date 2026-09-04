/**
 * Worker entrypoint for warming provider auth state off the main thread.
 */
import { serveWorkerTasks } from "../infra/worker-task-pool.js";
import { restorePreparedSyntheticAuthFacts } from "../plugins/provider-synthetic-auth.js";
import { listAgentIds } from "./agent-scope-config.js";
import { replaceRuntimeAuthProfileStoreSnapshots } from "./auth-profiles.js";
import type {
  ProviderAuthWarmWorkerInput,
  ProviderAuthWarmWorkerResult,
} from "./model-provider-auth-warm.js";
import { buildCurrentProviderAuthStateSnapshot } from "./model-provider-auth.js";

function isWorkerInput(value: unknown): value is ProviderAuthWarmWorkerInput {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    "cfg" in record &&
    Array.isArray(record.syntheticAuth) &&
    (!("runtimeAuthStores" in record) || Array.isArray(record.runtimeAuthStores)) &&
    (!("runtimeAuthLookups" in record) || Array.isArray(record.runtimeAuthLookups)) &&
    (!("omitFalseProviderAuth" in record) || typeof record.omitFalseProviderAuth === "boolean")
  );
}

/** Validates worker input and returns a provider auth snapshot or a serializable failure. */
export async function runProviderAuthWarmWorkerInput(
  input: unknown,
): Promise<ProviderAuthWarmWorkerResult> {
  if (!isWorkerInput(input)) {
    return {
      status: "failed",
      error: "invalid provider auth warm worker input",
    };
  }
  try {
    const syntheticAuth = new Map(input.syntheticAuth.map((scope) => [scope.agentId, scope]));
    for (const agentId of listAgentIds(input.cfg)) {
      const scope = syntheticAuth.get(agentId);
      if (!scope) {
        throw new Error(`Prepared synthetic auth scope is missing for ${agentId}`);
      }
      restorePreparedSyntheticAuthFacts(input.cfg, scope.facts, {
        workspaceDir: scope.workspaceDir,
      });
    }
    if (input.runtimeAuthStores?.length) {
      // Worker threads do not share module-local caches, so hydrate runtime stores explicitly.
      replaceRuntimeAuthProfileStoreSnapshots(input.runtimeAuthStores);
    }
    const snapshot = await buildCurrentProviderAuthStateSnapshot(input.cfg, {
      // Warmup should inspect existing auth only; prompting or writing here would surprise CLI callers.
      readOnlyAuthStore: true,
      runtimeAuthLookups: new Map(
        input.runtimeAuthLookups?.map(({ agentId, lookup }) => [agentId, lookup]),
      ),
      syntheticAuth,
      omitFalseProviderAuth: input.omitFalseProviderAuth,
    });
    return {
      status: "ok",
      snapshot,
    };
  } catch (error) {
    return {
      status: "failed",
      error: String(error),
    };
  }
}

serveWorkerTasks(runProviderAuthWarmWorkerInput);
