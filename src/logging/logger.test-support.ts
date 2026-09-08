import { fileLogTransport } from "./logger-file-transport.js";
import { defaultLoggerHostnameResolver, loggerHostnameState } from "./logger-hostname-state.js";

export const testApi = {
  drainFileLogQueueSyncForTests: fileLogTransport.drainSync,
  flushFileLogQueueForTests: fileLogTransport.flush,
  resetFileLogTransportForTests: fileLogTransport.resetForTests,
  setFileLogAppenderForTests: fileLogTransport.setAppenderForTests,
  setFileLogQueueMaxRecordsForTests: fileLogTransport.setMaxQueuedRecordsForTests,
  setHostnameResolverForTests(resolver?: () => string): void {
    loggerHostnameState.resolver = resolver ?? defaultLoggerHostnameResolver;
    loggerHostnameState.cached = null;
  },
};
