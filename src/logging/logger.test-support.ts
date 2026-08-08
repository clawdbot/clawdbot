import { expandHomePrefix } from "../infra/home-dir.js";
import { shouldSkipMutatingLoggingConfigRead } from "./config.js";
import { isLegacyRollingLogFilePath, resolveRollingLogFilePathForDate } from "./log-file-path.js";
import {
  drainFileLogQueueSync,
  flushFileLogQueue,
  resetFileLogTransportForTests,
  setFileLogAppenderForTests,
  setFileLogQueueMaxRecordsForTests,
} from "./logger-file-transport.js";
import { defaultLoggerHostnameResolver, loggerHostnameState } from "./logger-hostname-state.js";

export const testApi = {
  drainFileLogQueueSyncForTests: drainFileLogQueueSync,
  flushFileLogQueueForTests: flushFileLogQueue,
  resetFileLogTransportForTests,
  resolveActiveLogFile(file: string): string {
    const expandedFile = expandHomePrefix(file);
    return isLegacyRollingLogFilePath(expandedFile)
      ? resolveRollingLogFilePathForDate(expandedFile, new Date())
      : expandedFile;
  },
  setFileLogAppenderForTests,
  setFileLogQueueMaxRecordsForTests,
  setHostnameResolverForTests(resolver?: () => string): void {
    loggerHostnameState.resolver = resolver ?? defaultLoggerHostnameResolver;
    loggerHostnameState.cached = null;
  },
  shouldSkipMutatingLoggingConfigRead,
};
