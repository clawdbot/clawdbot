/**
 * Worker entrypoint for warming provider auth state off the main thread.
 */
import { serveWorkerTasks } from "../infra/worker-task-pool.js";
import { replaceRuntimeAuthProfileStoreSnapshots } from "./auth-profiles.js";
import {
  buildCurrentProviderAuthStateSnapshot,
  type ProviderAuthWarmWorkerInput,
  type ProviderAuthWarmWorkerResult,
} from "./model-provider-auth.js";

function isWorkerInput(value: unknown): value is ProviderAuthWarmWorkerInput {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    "cfg" in record &&
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
