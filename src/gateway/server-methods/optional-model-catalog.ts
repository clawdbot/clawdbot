// Optional model-catalog access gives session/tool methods metadata when ready
// while keeping provider discovery out of ordinary request hot paths.
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import type { GatewayModelCatalogSnapshot } from "../server-model-catalog.types.js";
import type { GatewayRequestContext } from "./types.js";

/**
 * Optional model-catalog loader for methods where metadata improves the result
 * but should never block the primary session response path.
 */
const DEFAULT_OPTIONAL_MODEL_CATALOG_TIMEOUT_MS = 750;

const loggedSlowCatalogKeys = new Set<string>();

type OptionalServerMethodModelCatalogLoad<T> = {
  promise: Promise<T | undefined>;
};

/** Reads already-published startup facts without starting provider discovery on an RPC hot path. */
export async function readPreparedServerMethodModelCatalog(
  context: GatewayRequestContext,
  options?: { agentId?: string },
): Promise<ModelCatalogEntry[] | undefined> {
  try {
    return context.readPreparedGatewayModelCatalog
      ? await context.readPreparedGatewayModelCatalog(options)
      : undefined;
  } catch {
    // Catalog metadata decorates these responses; owner selection or lifecycle
    // races must not make the primary roster/session RPC unavailable.
    return undefined;
  }
}

type LoadOptionalServerMethodModelCatalogOptions<T> = {
  loadParams?: Parameters<GatewayRequestContext["loadGatewayModelCatalogSnapshot"]>[0];
  logOnceKey?: string;
  startedLoad?: OptionalServerMethodModelCatalogLoad<T>;
  timeoutMs?: number;
};

function normalizeOptionalModelCatalogSnapshot(
  value: unknown,
): GatewayModelCatalogSnapshot | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const snapshot = value as Partial<GatewayModelCatalogSnapshot>;
  return typeof snapshot.agentDir === "string" &&
    snapshot.config &&
    Array.isArray(snapshot.entries) &&
    Array.isArray(snapshot.routeVariants)
    ? (snapshot as GatewayModelCatalogSnapshot)
    : undefined;
}

function startOptionalServerMethodModelCatalogValueLoad<T>(params: {
  load: () => Promise<unknown>;
  normalize: (value: unknown) => T | undefined;
}): OptionalServerMethodModelCatalogLoad<T> {
  let catalogPromise: Promise<unknown>;
  try {
    catalogPromise = params.load();
  } catch {
    catalogPromise = Promise.resolve(undefined);
  }
  return {
    promise: catalogPromise.then(params.normalize, () => undefined),
  };
}

export function startOptionalServerMethodModelCatalogSnapshotLoad(
  context: GatewayRequestContext,
  loadParams?: Parameters<GatewayRequestContext["loadGatewayModelCatalogSnapshot"]>[0],
): OptionalServerMethodModelCatalogLoad<GatewayModelCatalogSnapshot> {
  return startOptionalServerMethodModelCatalogValueLoad({
    load: () => context.loadGatewayModelCatalogSnapshot(loadParams),
    normalize: normalizeOptionalModelCatalogSnapshot,
  });
}

async function loadOptionalServerMethodModelCatalogValue<T>(
  context: GatewayRequestContext,
  surface: string,
  options: LoadOptionalServerMethodModelCatalogOptions<T> | undefined,
  startLoad: () => OptionalServerMethodModelCatalogLoad<T>,
): Promise<T | undefined> {
  let timeout: NodeJS.Timeout | undefined;
  const timedOut = Symbol("server-method-model-catalog-timeout");
  const timeoutMs = options?.timeoutMs ?? DEFAULT_OPTIONAL_MODEL_CATALOG_TIMEOUT_MS;
  const catalogLoad = options?.startedLoad ?? startLoad();
  const timeoutPromise = new Promise<typeof timedOut>((resolve) => {
    timeout = setTimeout(() => resolve(timedOut), timeoutMs);
    timeout.unref?.();
  });
  try {
    const result = await Promise.race([catalogLoad.promise, timeoutPromise]);
    if (result === timedOut) {
      const logOnceKey = options?.logOnceKey ?? "session-metadata";
      if (!loggedSlowCatalogKeys.has(logOnceKey)) {
        loggedSlowCatalogKeys.add(logOnceKey);
        context.logGateway.debug(
          `${surface} continuing without model catalog after ${timeoutMs}ms`,
        );
      }
      return undefined;
    }
    return result;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

/** Loads the full gateway model catalog snapshot without blocking the primary response path. */
export async function loadOptionalServerMethodModelCatalogSnapshot(
  context: GatewayRequestContext,
  surface: string,
  options?: LoadOptionalServerMethodModelCatalogOptions<GatewayModelCatalogSnapshot>,
): Promise<GatewayModelCatalogSnapshot | undefined> {
  return await loadOptionalServerMethodModelCatalogValue(context, surface, options, () =>
    startOptionalServerMethodModelCatalogSnapshotLoad(context, options?.loadParams),
  );
}
