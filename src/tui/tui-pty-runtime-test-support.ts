// One build must preserve payload metadata identity across all fixture imports.
const currentModuleUrl = import.meta.url;

export const tuiPtyRuntimeEntrypoints = {
  tui: {
    currentModuleUrl,
    sourceWorkerName: "tui",
    distWorkerPath: "tui/tui.js",
  },
  embeddedPayloads: {
    currentModuleUrl,
    sourceWorkerName: "../agents/embedded-agent-runner/run/payloads",
    distWorkerPath: "agents/embedded-agent-runner/run/payloads.js",
  },
  replyPayload: {
    currentModuleUrl,
    sourceWorkerName: "../auto-reply/reply-payload",
    distWorkerPath: "auto-reply/reply-payload.js",
  },
  outboundPayloads: {
    currentModuleUrl,
    sourceWorkerName: "../infra/outbound/payloads",
    distWorkerPath: "infra/outbound/payloads.js",
  },
} as const;
