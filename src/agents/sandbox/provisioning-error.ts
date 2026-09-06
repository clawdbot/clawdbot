import { formatErrorMessage } from "../../infra/errors.js";
import {
  isTrustedSecretSurfaceUnavailableError,
  SECRET_DEGRADATION_RETRY_HINT,
} from "../../secrets/runtime-degraded-state.js";

const SANDBOX_PROVISIONING_ERROR_CODE = "sandbox_provisioning";

/** Model-independent sandbox setup failure that must not consume model fallbacks. */
class SandboxProvisioningError extends Error {
  readonly code = SANDBOX_PROVISIONING_ERROR_CODE;
  readonly backendId: string;

  constructor(message: string, params: { backendId: string; cause?: unknown }) {
    super(message, { cause: params.cause });
    this.name = "SandboxProvisioningError";
    this.backendId = params.backendId;
  }
}

/** Preserve an existing typed failure or attach sandbox ownership to a backend setup error. */
export function toSandboxProvisioningError(error: unknown, backendId: string) {
  if (error instanceof SandboxProvisioningError) {
    return error;
  }
  const detail = formatErrorMessage(error) || `Sandbox backend "${backendId}" provisioning failed.`;
  const message = isTrustedSecretSurfaceUnavailableError(error)
    ? `${detail} Fix the referenced secret, run \`${SECRET_DEGRADATION_RETRY_HINT}\`, then retry.`
    : detail;
  return new SandboxProvisioningError(message, { backendId, cause: error });
}

/** Recognize the provisioning marker through ordinary error-wrapper cause chains. */
export function isSandboxProvisioningError(error: unknown, seen: Set<object> = new Set()): boolean {
  if (error instanceof SandboxProvisioningError) {
    return true;
  }
  if (!error || typeof error !== "object" || seen.has(error)) {
    return false;
  }
  seen.add(error);
  const candidate = error as {
    name?: unknown;
    code?: unknown;
    cause?: unknown;
    error?: unknown;
    errors?: unknown;
  };
  if (
    candidate.name === "SandboxProvisioningError" &&
    candidate.code === SANDBOX_PROVISIONING_ERROR_CODE
  ) {
    return true;
  }
  return [
    candidate.cause,
    candidate.error,
    ...(Array.isArray(candidate.errors) ? candidate.errors : []),
  ].some((nested) => isSandboxProvisioningError(nested, seen));
}
