import { instrumentPluginInstanceApi } from "./api-facades.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { PluginInstance } from "./plugin-instance.js";
import { createPluginApiFactory } from "./registry-api.js";
import { projectPluginContributions } from "./registry-contributions.js";
import { createPluginRegistrars } from "./registry-registrars.js";
import { createPluginRuntimeResolver } from "./registry-runtime.js";
import { createPluginRegistryState } from "./registry-state.js";
import type {
  PluginRecord as RegistryPluginRecord,
  PluginRegistryParams,
} from "./registry-types.js";

export type {
  PluginHttpRouteRegistration,
  PluginRecord,
  PluginRegistry,
} from "./registry-types.js";
export { createEmptyPluginRegistry } from "./registry-empty.js";

function clonePluginRecord(record: RegistryPluginRecord): RegistryPluginRecord {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, Array.isArray(value) ? [...value] : value]),
  ) as RegistryPluginRecord;
}

/**
 * Compose the registry state, domain registrars, scoped runtime, and plugin API.
 * Domain modules own validation and mutation; this function owns lifecycle wiring only.
 */
export function createPluginRegistry(registryParams: PluginRegistryParams) {
  const state = createPluginRegistryState(registryParams);
  const registrars = createPluginRegistrars(state);
  const runtimeResolver = createPluginRuntimeResolver(state);
  const createPluginApi = createPluginApiFactory(state, registrars, runtimeResolver);
  const registrationRecordSnapshots = new WeakMap<RegistryPluginRecord, RegistryPluginRecord>();
  const createApi: typeof createPluginApi = (record, params) => {
    registrationRecordSnapshots.set(record, clonePluginRecord(record));
    const api = createPluginApi(record, params);
    return instrumentPluginInstanceApi(
      api,
      getPluginInstance(record) ??
        new PluginInstance(record.id, { record, registry: state.registry }),
    );
  };

  const rollbackPluginGlobalSideEffects = (pluginId: string, record: RegistryPluginRecord) => {
    runtimeResolver.revokePluginRuntimeRecord(pluginId, record);
    projectPluginContributions(state.registry, record);
    const recordSnapshot = registrationRecordSnapshots.get(record);
    if (recordSnapshot) {
      Object.keys(record).forEach((key) => Reflect.deleteProperty(record, key));
      Object.assign(record, recordSnapshot);
      registrationRecordSnapshots.delete(record);
    }
  };

  return {
    ...registrars,
    registry: state.registry,
    createApi,
    rollbackPluginGlobalSideEffects,
    pushDiagnostic: state.pushDiagnostic,
  };
}
