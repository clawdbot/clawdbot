import { createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
/**
 * Built-in stateful binding target registration.
 *
 * Lazily registers ACP target drivers so non-ACP channel flows avoid ACP runtime imports.
 */
import { registerStatefulBindingTargetDriver } from "./stateful-target-drivers.js";

let builtinsRegisteredPromise: Promise<void> | null = null;

const loadAcpStatefulTargetDriverModule = createLazyRuntimeModule(
  () => import("./acp-stateful-target-driver.js"),
);

export function isStatefulTargetBuiltinDriverId(id: string): boolean {
  return id.trim() === "acp";
}

export async function ensureStatefulTargetBuiltinsRegistered(): Promise<void> {
  if (builtinsRegisteredPromise) {
    await builtinsRegisteredPromise;
    return;
  }
  builtinsRegisteredPromise = (async () => {
    const { acpStatefulBindingTargetDriver } = await loadAcpStatefulTargetDriverModule();
    registerStatefulBindingTargetDriver(acpStatefulBindingTargetDriver);
  })();
  try {
    await builtinsRegisteredPromise;
  } catch (error) {
    // Retry after failed dynamic import/registration; a rejected singleton would
    // otherwise permanently disable later setup or binding attempts.
    builtinsRegisteredPromise = null;
    throw error;
  }
}
