export type LoggerTestApi = {
  drainFileLogQueueSyncForTests: typeof import("./logger-file-transport.js").drainFileLogQueueSync;
  flushFileLogQueueForTests: typeof import("./logger-file-transport.js").flushFileLogQueue;
  resetFileLogTransportForTests: typeof import("./logger-file-transport.js").resetFileLogTransportForTests;
  resolveActiveLogFile(file: string): string;
  setFileLogAppenderForTests: typeof import("./logger-file-transport.js").setFileLogAppenderForTests;
  setFileLogQueueMaxRecordsForTests: typeof import("./logger-file-transport.js").setFileLogQueueMaxRecordsForTests;
  setHostnameResolverForTests(resolver?: () => string): void;
  shouldSkipMutatingLoggingConfigRead: typeof import("./config.js").shouldSkipMutatingLoggingConfigRead;
};
