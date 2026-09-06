// The test invocation prepares the real restart fixture before its startup deadline.
export const channelIngressGatewayRestartEntrypoint = {
  currentModuleUrl: import.meta.url,
  sourceWorkerName: "channel-ingress-gateway-restart",
  distWorkerPath: "test-support/channel-ingress-gateway-restart.js",
} as const;
