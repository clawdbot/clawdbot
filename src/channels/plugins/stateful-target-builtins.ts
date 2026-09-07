import { createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
/**
 * Built-in stateful binding target registration.
 *
 * Lazily registers ACP target drivers so non-ACP channel flows avoid ACP runtime imports.
 */
import { registerStatefulBindingTargetDriver } from "./stateful-target-drivers.js";

const loadAcpStatefulTargetDriverModule = createLazyRuntimeModule(
  () => import("./acp-stateful-target-driver.js"),
);

export function isStatefulTargetBuiltinDriverId(id: string): boolean {
  return id.trim() === "acp";
}

export async function ensureStatefulTargetBuiltinsRegistered(): Promise<void> {
  try {
    const { acpStatefulBindingTargetDriver } = await loadAcpStatefulTargetDriverModule();
    registerStatefulBindingTargetDriver(acpStatefulBindingTargetDriver);
  } catch (error) {
    // A rejected lazy import is cached; clear it so a later setup or binding attempt can retry.
    loadAcpStatefulTargetDriverModule.clear();
    throw error;
  }
}
