// Compile both runtime roots before the retention child's bounded heap measurement.
const currentModuleUrl = import.meta.url;

export const sessionTitleRetentionEntrypoints = {
  titleReader: {
    currentModuleUrl,
    sourceWorkerName: "session-transcript-title-reader",
    distWorkerPath: "gateway/session-transcript-title-reader.js",
  },
  sessionUtils: {
    currentModuleUrl,
    sourceWorkerName: "session-utils-core",
    distWorkerPath: "gateway/session-utils-core.js",
  },
} as const;
