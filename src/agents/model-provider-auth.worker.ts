import { parentPort, workerData } from "node:worker_threads";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { replaceRuntimeAuthProfileStoreSnapshots, type AuthProfileStore } from "./auth-profiles.js";
import type { RuntimeProviderAuthLookup } from "./model-auth.js";
import { buildCurrentProviderAuthStateSnapshot } from "./model-provider-auth.js";

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
  return (
    value !== null &&
    typeof value === "object" &&
    "cfg" in value &&
    (!("runtimeAuthStores" in value) ||
      Array.isArray((value as { runtimeAuthStores?: unknown }).runtimeAuthStores)) &&
    (!("runtimeAuthLookups" in value) ||
      Array.isArray((value as { runtimeAuthLookups?: unknown }).runtimeAuthLookups)) &&
    (!("omitFalseProviderAuth" in value) ||
      typeof (value as { omitFalseProviderAuth?: unknown }).omitFalseProviderAuth === "boolean")
  );
}

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
      replaceRuntimeAuthProfileStoreSnapshots(input.runtimeAuthStores);
    }
    const snapshot = await buildCurrentProviderAuthStateSnapshot(input.cfg, {
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
