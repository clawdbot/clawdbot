// Both concurrent writers must use the same runtime graph and version metadata.
export const cliRecoveryEntrypoints = {
  cli: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../entry",
    distWorkerPath: "entry.js",
  },
  sessionAccessor: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../config/sessions/session-accessor",
    distWorkerPath: "config/sessions/session-accessor.js",
  },
  cliSession: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../agents/cli-session",
    distWorkerPath: "agents/cli-session.js",
  },
} as const;

// Direct-stop children use the invocation's prepared graph before readiness starts.
export const gatewayDirectStopEntrypoints = {
  ingressDrain: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../channels/message/ingress-drain",
    distWorkerPath: "channels/message/ingress-drain.js",
  },
  ingressQueue: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../channels/message/ingress-queue",
    distWorkerPath: "channels/message/ingress-queue.js",
  },
  runs: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../agents/embedded-agent-runner/runs",
    distWorkerPath: "agents/embedded-agent-runner/runs.js",
  },
  activeRunProjections: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../agents/embedded-agent-runner/active-run-projections",
    distWorkerPath: "agents/embedded-agent-runner/active-run-projections.js",
  },
  runLoop: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "gateway-cli/run-loop",
    distWorkerPath: "cli/gateway-cli/run-loop.js",
  },
  workAdmission: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../process/gateway-work-admission",
    distWorkerPath: "process/gateway-work-admission.js",
  },
} as const;
