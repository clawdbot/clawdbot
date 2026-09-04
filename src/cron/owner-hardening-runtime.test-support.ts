// Compile both roots together so the activation-crash trigger uses Cron's database connection.
const currentModuleUrl = import.meta.url;

export const cronOwnerHardeningEntrypoints = {
  service: {
    currentModuleUrl,
    sourceWorkerName: "service",
    distWorkerPath: "cron/service.js",
  },
  stateDatabase: {
    currentModuleUrl,
    sourceWorkerName: "../state/openclaw-state-db",
    distWorkerPath: "state/openclaw-state-db.js",
  },
} as const;
