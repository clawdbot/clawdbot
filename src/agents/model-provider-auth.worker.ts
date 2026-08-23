/**
 * Worker entrypoint for warming provider auth state off the main thread.
 */
import { parentPort, workerData } from "node:worker_threads";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { replaceRuntimeAuthProfileStoreSnapshots, type AuthProfileStore } from "./auth-profiles.js";
import type { RuntimeProviderAuthLookup } from "./model-auth.js";
import { buildCurrentProviderAuthStateSnapshot } from "./model-provider-auth.js";

/**
 * Worker entrypoint for warming provider auth state without blocking the foreground
 * model-selection path.
 */
type ProviderAuthWarmRuntimeAuthStore = {
  agentDir?: string;
  store: AuthProfileStore;
};

type ProviderAuthWarmWorkerInput = {
  cfg: OpenClawConfig;
  runtimeAuthStores?: ProviderAuthWarmRuntimeAuthStore[];
  runtimeAuthLookups?: Array<{
    agentId: string;
    lookup: RuntimeProviderAuthLookup;
  }>;
  omitFalseProviderAuth?: boolean;
};

type ProviderAuthWarmWorkerResult =
  | {
      status: "ok";
      snapshot: Awaited<ReturnType<typeof buildCurrentProviderAuthStateSnapshot>>;
    }
  | {
      status: "failed";
      error: string;
    };

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

if (parentPort) {
  const sendToParent: (message: ProviderAuthWarmWorkerResult) => void =
    parentPort.postMessage.bind(parentPort);
  sendToParent(await runProviderAuthWarmWorkerInput(workerData));
}
