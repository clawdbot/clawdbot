import { MEMORY_AUTHORIZATION_CONTRACT_VERSION } from "../memory-host-sdk/host/authorization.js";
import { inspectMemoryAuthorizationCapability } from "./memory-authorization-runtime.js";
import type { PluginRegistry } from "./registry-types.js";

const inspectedRegistries = new WeakSet<PluginRegistry>();

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

/**
 * Shadow mode returns bounded surface counts once per selected registry. Reflection failures are
 * nonconforming observations; logging remains with the runtime owner and cannot change selection.
 */
export function observeMemoryAuthorizationShadowSurface(
  params: Readonly<{ capability: unknown; registry: PluginRegistry }>,
): MemoryAuthorizationShadowMetadata | undefined {
  try {
    if (inspectedRegistries.has(params.registry)) {
      return undefined;
    }
    inspectedRegistries.add(params.registry);
    const inspection = inspectMemoryAuthorizationCapability(params.capability);
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
