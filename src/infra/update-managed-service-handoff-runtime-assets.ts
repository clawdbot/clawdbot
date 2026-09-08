export const MANAGED_HANDOFF_RUNTIME_ENTRY = "managed-handoff-runtime.mjs";
export const managedHandoffRuntimeEntrypoint = {
  currentModuleUrl: import.meta.url,
  sourceWorkerName: "update-managed-service-handoff-sealed",
  distWorkerPath: MANAGED_HANDOFF_RUNTIME_ENTRY,
};
