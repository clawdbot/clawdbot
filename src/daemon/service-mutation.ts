import type { GatewayLifecycleMutationMode, GatewayServiceControlArgs } from "./service-types.js";

/** Isolate diagnostic observers from authoritative service-control mutations. */
export function createGatewayLifecycleMutationReporter(
  onMutation: GatewayServiceControlArgs["onMutation"],
): (mode: GatewayLifecycleMutationMode) => void {
  return (mode) => {
    try {
      onMutation?.({ mode });
    } catch {
      // Audit observers are diagnostic; never interrupt service control.
    }
  };
}
