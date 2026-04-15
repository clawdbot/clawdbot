import { loadBundledEntryExportSync } from "openclaw/plugin-sdk/channel-entry-contract";

type SetupSurfaceModule = typeof import("./src/setup-surface.js");

function createLazyObjectValue<T extends object>(load: () => T): T {
  return new Proxy({} as T, {
    get(_target, property, receiver) {
      return Reflect.get(load(), property, receiver);
    },
    has(_target, property) {
      return property in load();
    },
    ownKeys() {
      return Reflect.ownKeys(load());
    },
    getOwnPropertyDescriptor(_target, property) {
      const descriptor = Object.getOwnPropertyDescriptor(load(), property);
      return descriptor ? { ...descriptor, configurable: true } : undefined;
    },
  });
}

function loadSetupSurfaceModule(): SetupSurfaceModule {
  return loadBundledEntryExportSync<SetupSurfaceModule>(import.meta.url, {
    specifier: "./src/setup-surface.js",
  });
}

export { zaloDmPolicy, zaloSetupAdapter, createZaloSetupWizardProxy } from "./src/setup-core.js";
export { evaluateZaloGroupAccess, resolveZaloRuntimeGroupPolicy } from "./src/group-access.js";

export const zaloSetupWizard: SetupSurfaceModule["zaloSetupWizard"] = createLazyObjectValue(
  () => loadSetupSurfaceModule().zaloSetupWizard as object,
) as SetupSurfaceModule["zaloSetupWizard"];
