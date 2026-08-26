import { isDeepStrictEqual } from "node:util";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { resolveSharedAuthStorePath } from "./path-resolve.js";
import { resolveAuthProfileDatabasePath } from "./sqlite.js";

/** Secret-free proof that one exact provider/model transport completed with usable auth. */
export type RuntimeAuthMaterialization = Readonly<{
  provider: string;
  modelId: string;
  modelApi: string;
  modelBaseUrl: string;
  requestTransportOverrides: "none" | "present";
  authMode: string;
  runtimeOwnerId: string;
  authProfileId?: string;
}>;

type RuntimeAuthMaterializationMutationListener = (event: {
  agentDir?: string;
  affectsInheritedStores: boolean;
}) => void;

const MAX_RUNTIME_AUTH_MATERIALIZATIONS_PER_OWNER = 64;
const materializations = new Map<string, RuntimeAuthMaterialization[]>();
const listeners = new Set<RuntimeAuthMaterializationMutationListener>();

function ownerKey(agentDir?: string): string {
  return agentDir ? resolveAuthProfileDatabasePath(agentDir) : resolveSharedAuthStorePath();
}

function notify(agentDir?: string): void {
  const event = {
    ...(agentDir ? { agentDir } : {}),
    affectsInheritedStores: agentDir === undefined,
  };
  for (const listener of listeners) {
    listener(event);
  }
}

export function registerRuntimeAuthMaterializationMutationListener(
  listener: RuntimeAuthMaterializationMutationListener,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Records successful auth at the boundary that proved one exact runtime route. */
export function recordRuntimeAuthMaterialization(params: {
  agentDir?: string;
  provider: string;
  modelId: string;
  modelApi: string;
  modelBaseUrl: string;
  requestTransportOverrides: "none" | "present";
  authMode: string;
  runtimeOwnerId: string;
  authProfileId?: string;
}): boolean {
  const provider = normalizeProviderId(params.provider);
  const fact: RuntimeAuthMaterialization = {
    provider,
    modelId: params.modelId.trim().toLowerCase(),
    modelApi: params.modelApi.trim().toLowerCase(),
    modelBaseUrl: params.modelBaseUrl.trim(),
    requestTransportOverrides: params.requestTransportOverrides,
    authMode: params.authMode.trim().toLowerCase(),
    runtimeOwnerId: params.runtimeOwnerId.trim().toLowerCase(),
    ...(params.authProfileId?.trim() ? { authProfileId: params.authProfileId.trim() } : {}),
  };
  if (Object.values(fact).some((value) => !value)) {
    return false;
  }
  const key = ownerKey(params.agentDir);
  const existing = materializations.get(key) ?? [];
  if (existing.some((candidate) => isDeepStrictEqual(candidate, fact))) {
    return false;
  }
  materializations.set(
    key,
    [...existing, fact].slice(-MAX_RUNTIME_AUTH_MATERIALIZATIONS_PER_OWNER),
  );
  notify(params.agentDir);
  return true;
}

/** Revokes all facts backed by one runtime owner after a classified auth failure. */
export function revokeRuntimeAuthMaterializations(params: {
  agentDir?: string;
  provider: string;
  runtimeOwnerId: string;
}): boolean {
  const key = ownerKey(params.agentDir);
  const provider = normalizeProviderId(params.provider);
  const runtimeOwnerId = params.runtimeOwnerId.trim().toLowerCase();
  const existing = materializations.get(key);
  if (!provider || !runtimeOwnerId || !existing) {
    return false;
  }
  const next = existing.filter(
    (fact) => fact.provider !== provider || fact.runtimeOwnerId !== runtimeOwnerId,
  );
  if (next.length === existing.length) {
    return false;
  }
  if (next.length) {
    materializations.set(key, next);
  } else {
    materializations.delete(key);
  }
  notify(params.agentDir);
  return true;
}

export function getPreparedRuntimeAuthMaterializations(
  agentDir?: string,
): readonly RuntimeAuthMaterialization[] {
  return materializations.get(ownerKey(agentDir)) ?? [];
}

export function clearRuntimeAuthMaterializations(agentDir?: string): void {
  materializations.delete(ownerKey(agentDir));
}

/** Clears materializations for an already resolved canonical auth database owner. */
export function clearRuntimeAuthMaterializationsAtDatabasePath(databasePath: string): void {
  materializations.delete(databasePath);
}

export function clearAllRuntimeAuthMaterializations(): void {
  materializations.clear();
}
