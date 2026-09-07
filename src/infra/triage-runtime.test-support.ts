// Real child imports share the invocation build before readiness budgets begin.
const currentModuleUrl = import.meta.url;

// These owners must share one graph, with a native-mockable service edge.
export const triageMaintenanceRuntimeEntrypoints = {
  service: {
    currentModuleUrl,
    sourceWorkerName: "../daemon/service",
    distWorkerPath: "triage-maintenance/service.js",
  },
  doctor: {
    currentModuleUrl,
    sourceWorkerName: "../commands/doctor-maintenance",
    distWorkerPath: "triage-maintenance/doctor.js",
  },
  update: {
    currentModuleUrl,
    sourceWorkerName: "../cli/update-cli/update-command-service-maintenance",
    distWorkerPath: "triage-maintenance/update.js",
  },
} as const;

export const triageTestRuntimeEntrypoints = {
  requester: {
    currentModuleUrl,
    sourceWorkerName: "update-requester-authority",
    distWorkerPath: "infra/update-requester-authority.js",
  },
  updateRunLedger: {
    currentModuleUrl,
    sourceWorkerName: "update-run-ledger",
    distWorkerPath: "infra/update-run-ledger.js",
  },
  updateHandoff: {
    currentModuleUrl,
    sourceWorkerName: "../cli/update-cli/update-command-handoff",
    distWorkerPath: "cli/update-cli/update-command-handoff.js",
  },
  continuation: {
    currentModuleUrl,
    sourceWorkerName: "triage-continuation",
    distWorkerPath: "infra/triage-continuation.js",
  },
  failure: {
    currentModuleUrl,
    sourceWorkerName: "../commands/triage-failure",
    distWorkerPath: "commands/triage-failure.js",
  },
  exec: {
    currentModuleUrl,
    sourceWorkerName: "../process/exec-runner",
    distWorkerPath: "process/exec-runner.js",
  },
  identity: {
    currentModuleUrl,
    sourceWorkerName: "../shared/pid-alive",
    distWorkerPath: "shared/pid-alive.js",
  },
  respawn: {
    currentModuleUrl,
    sourceWorkerName: "../entry.respawn",
    distWorkerPath: "entry.respawn.js",
  },
} as const;
