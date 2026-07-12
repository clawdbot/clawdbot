// Optional model-catalog loading gives session/tool methods metadata when fast
// while never blocking their primary response path on catalog discovery.
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
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

type LoadOptionalServerMethodModelCatalogOptions<T> = {
  logOnceKey?: string;
  startedLoad?: OptionalServerMethodModelCatalogLoad<T>;
  timeoutMs?: number;
};

function normalizeOptionalModelCatalog(value: unknown): ModelCatalogEntry[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function normalizeOptionalModelCatalogSnapshot(value: unknown): ModelCatalogSnapshot | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const snapshot = value as Partial<ModelCatalogSnapshot>;
  return Array.isArray(snapshot.entries) && Array.isArray(snapshot.routeVariants)
    ? { entries: snapshot.entries, routeVariants: snapshot.routeVariants }
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

function startOptionalServerMethodModelCatalogLoad(
  context: GatewayRequestContext,
): OptionalServerMethodModelCatalogLoad<ModelCatalogEntry[]> {
  return startOptionalServerMethodModelCatalogValueLoad({
    load: () => context.loadGatewayModelCatalog(),
    normalize: normalizeOptionalModelCatalog,
  });
}

export function startOptionalServerMethodModelCatalogSnapshotLoad(
  context: GatewayRequestContext,
): OptionalServerMethodModelCatalogLoad<ModelCatalogSnapshot> {
  return startOptionalServerMethodModelCatalogValueLoad({
    load: () => context.loadGatewayModelCatalogSnapshot(),
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

/** Loads the gateway model catalog with a short timeout and one-time slow logs. */
export async function loadOptionalServerMethodModelCatalog(
  context: GatewayRequestContext,
  surface: string,
  options?: LoadOptionalServerMethodModelCatalogOptions<ModelCatalogEntry[]>,
): Promise<ModelCatalogEntry[] | undefined> {
  return await loadOptionalServerMethodModelCatalogValue(context, surface, options, () =>
    startOptionalServerMethodModelCatalogLoad(context),
  );
}

/** Loads the full gateway model catalog snapshot without blocking the primary response path. */
export async function loadOptionalServerMethodModelCatalogSnapshot(
  context: GatewayRequestContext,
  surface: string,
  options?: LoadOptionalServerMethodModelCatalogOptions<ModelCatalogSnapshot>,
): Promise<ModelCatalogSnapshot | undefined> {
  return await loadOptionalServerMethodModelCatalogValue(context, surface, options, () =>
    startOptionalServerMethodModelCatalogSnapshotLoad(context),
  );
}
