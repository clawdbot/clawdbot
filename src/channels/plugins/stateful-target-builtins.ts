import {
  registerStatefulBindingTargetDriver,
  unregisterStatefulBindingTargetDriver,
} from "./stateful-target-drivers.js";

let builtinsRegisteredPromise: Promise<void> | null = null;

export function isStatefulTargetBuiltinDriverId(id: string): boolean {
  return id.trim() === "acp";
}

export async function ensureStatefulTargetBuiltinsRegistered(): Promise<void> {
  if (builtinsRegisteredPromise) {
    await builtinsRegisteredPromise;
    return;
  }
  builtinsRegisteredPromise = (async () => {
    const { acpStatefulBindingTargetDriver } = await import("./acp-stateful-target-driver.js");
    registerStatefulBindingTargetDriver(acpStatefulBindingTargetDriver);
  })();
  try {
    await builtinsRegisteredPromise;
  } catch (error) {
    builtinsRegisteredPromise = null;
    throw error;
  }
}

export async function resetStatefulTargetBuiltinsForTesting(): Promise<void> {
  builtinsRegisteredPromise = null;
  const { acpStatefulBindingTargetDriver } = await import("./acp-stateful-target-driver.js");
  unregisterStatefulBindingTargetDriver(acpStatefulBindingTargetDriver.id);
}
