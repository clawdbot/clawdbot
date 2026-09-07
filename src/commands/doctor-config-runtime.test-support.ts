// Fresh Doctor script processes share compiled config and install-index module identities.
export const doctorConfigRuntimeEntrypoints = {
  configFlow: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "doctor-config-flow",
    distWorkerPath: "commands/doctor-config-flow.js",
  },
  configHealth: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../flows/doctor-health-contribution-runners.config",
    distWorkerPath: "flows/doctor-health-contribution-runners.config.js",
  },
  installRecords: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../plugins/installed-plugin-index-records",
    distWorkerPath: "plugins/installed-plugin-index-records.js",
  },
} as const;
