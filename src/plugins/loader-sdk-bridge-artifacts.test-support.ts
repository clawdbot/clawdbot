// Published plugin compatibility uses the same compiled SDK graph as native execution.
const currentModuleUrl = import.meta.url;
export const publishedSdkBridgeEntrypoints = [
  {
    currentModuleUrl,
    sourceWorkerName: "../plugin-sdk/runtime-doctor",
    distWorkerPath: "plugin-sdk/runtime-doctor.js",
  },
  {
    currentModuleUrl,
    sourceWorkerName: "../plugin-sdk/channel-feedback",
    distWorkerPath: "plugin-sdk/channel-feedback.js",
  },
  {
    currentModuleUrl,
    sourceWorkerName: "../plugin-sdk/channel-outbound",
    distWorkerPath: "plugin-sdk/channel-outbound.js",
  },
] as const;
