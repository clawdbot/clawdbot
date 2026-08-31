import { expandHomePrefix } from "../infra/home-dir.js";
import { isLegacyRollingLogFilePath, resolveRollingLogFilePathForDate } from "./log-file-path.js";
import { fileLogTransport } from "./logger-file-transport.js";
import { defaultLoggerHostnameResolver, loggerHostnameState } from "./logger-hostname-state.js";

export const testApi = {
  drainFileLogQueueSyncForTests: fileLogTransport.drainSync,
  flushFileLogQueueForTests: fileLogTransport.flush,
  resetFileLogTransportForTests: fileLogTransport.resetForTests,
  resolveActiveLogFile(file: string): string {
    const expandedFile = expandHomePrefix(file);
    return isLegacyRollingLogFilePath(expandedFile)
      ? resolveRollingLogFilePathForDate(expandedFile, new Date())
      : expandedFile;
  },
  setFileLogAppenderForTests: fileLogTransport.setAppenderForTests,
  setFileLogQueueMaxRecordsForTests: fileLogTransport.setMaxQueuedRecordsForTests,
  setHostnameResolverForTests(resolver?: () => string): void {
    loggerHostnameState.resolver = resolver ?? defaultLoggerHostnameResolver;
    loggerHostnameState.cached = null;
  },
};
