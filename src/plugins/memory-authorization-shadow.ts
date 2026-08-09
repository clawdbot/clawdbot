import { MEMORY_AUTHORIZATION_CONTRACT_VERSION } from "../memory-host-sdk/host/authorization.js";
import { inspectMemoryAuthorizationRuntime } from "./memory-authorization-runtime.js";

const inspectedRuntimes = new WeakSet<object>();

type MemoryAuthorizationShadowMetadata = Readonly<{
  event: "memory-authorization-backend-surface";
  mode: "shadow";
  contractVersion: 1;
  capabilityDeclaration: "missing" | "malformed" | "partial" | "complete";
  declaredCapabilityCount: number;
  requiredCapabilityCount: number;
  implementedMethodCount: number;
  requiredMethodCount: number;
  surfaceComplete: boolean;
  reasonCode: "surface-complete" | "backend-nonconforming";
}>;

function isObjectReference(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

/**
 * Shadow mode returns bounded surface counts once per selected runtime. Reflection failures are
 * nonconforming observations; logging remains with the runtime owner and cannot change selection.
 */
export function observeMemoryAuthorizationShadowSurface(
  runtime: unknown,
): MemoryAuthorizationShadowMetadata | undefined {
  if (!isObjectReference(runtime)) {
    return undefined;
  }
  try {
    if (inspectedRuntimes.has(runtime)) {
      return undefined;
    }
    inspectedRuntimes.add(runtime);
    const inspection = inspectMemoryAuthorizationRuntime(runtime);
    const metadata = Object.freeze({
      event: "memory-authorization-backend-surface" as const,
      mode: "shadow" as const,
      contractVersion: MEMORY_AUTHORIZATION_CONTRACT_VERSION,
      capabilityDeclaration: inspection.capabilityDeclaration,
      declaredCapabilityCount: inspection.declaredCapabilityCount,
      requiredCapabilityCount: inspection.requiredCapabilityCount,
      implementedMethodCount: inspection.implementedMethodCount,
      requiredMethodCount: inspection.requiredMethodCount,
      surfaceComplete: inspection.surfaceComplete,
      reasonCode: inspection.reasonCode,
    });
    return metadata;
  } catch {
    return undefined;
  }
}
