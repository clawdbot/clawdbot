import type {
  MediaUnderstandingCapability,
  MediaUnderstandingModelConfig,
} from "../config/types.tools.js";
import {
  findActiveDegradedSecretOwner,
  SecretSurfaceUnavailableError,
} from "./runtime-degraded-state.js";

/** Runtime owner for one configured media-understanding model entry. */
export function runtimeMediaModelSecretOwnerId(
  params: {
    index: number;
  } & ({ source: "shared" } | { source: "capability"; capability: MediaUnderstandingCapability }),
): string {
  return params.source === "shared"
    ? `media-model:shared:${params.index}`
    : `media-model:${params.capability}:${params.index}`;
}

/** Runtime owner for request defaults inherited by one media capability. */
export function runtimeMediaRequestSecretOwnerId(capability: MediaUnderstandingCapability): string {
  return `media-model:${capability}:request`;
}

function modelRequestOverridesPath(entry: MediaUnderstandingModelConfig, path: string): boolean {
  const request = entry.request;
  const requestPath = path.split(".request.")[1];
  if (!request || !requestPath) {
    return false;
  }
  if (requestPath.startsWith("auth.")) {
    return request.auth !== undefined;
  }
  if (requestPath.startsWith("tls.")) {
    return request.tls !== undefined;
  }
  if (requestPath.startsWith("proxy.")) {
    return request.proxy !== undefined;
  }
  const headerName = requestPath.startsWith("headers.")
    ? requestPath.slice("headers.".length).toLowerCase()
    : undefined;
  return Boolean(
    headerName &&
    Object.keys(request.headers ?? {}).some((key) => key.toLowerCase() === headerName),
  );
}

/** Rejects a cold capability request only when the model still inherits its failed field. */
export function assertRuntimeMediaRequestSecretOwnerAvailable(params: {
  capability: MediaUnderstandingCapability;
  entry: MediaUnderstandingModelConfig;
}): void {
  const owner = findActiveDegradedSecretOwner(
    "capability",
    runtimeMediaRequestSecretOwnerId(params.capability),
  );
  if (owner && owner.paths.some((path) => !modelRequestOverridesPath(params.entry, path))) {
    throw new SecretSurfaceUnavailableError(owner);
  }
}
