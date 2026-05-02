import { registerStatefulBindingTargetDriver } from "./stateful-target-drivers.js";

type AcpStatefulTargetDriverModule = typeof import("./acp-stateful-target-driver.js");

let builtinsRegisteredPromise: Promise<void> | null = null;
let acpDriverModulePromise: Promise<AcpStatefulTargetDriverModule> | undefined;

function loadAcpStatefulTargetDriverModule(): Promise<AcpStatefulTargetDriverModule> {
  acpDriverModulePromise ??= import("./acp-stateful-target-driver.js");
  return acpDriverModulePromise;
}

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
    builtinsRegisteredPromise = null;
    throw error;
  }
}
