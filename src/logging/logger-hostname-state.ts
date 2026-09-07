import os from "node:os";

type LoggerHostnameResolver = () => string;

export const defaultLoggerHostnameResolver: LoggerHostnameResolver = () => os.hostname();

export const loggerHostnameState: {
  cached: string | null;
  resolver: LoggerHostnameResolver;
} = {
  cached: null,
  resolver: defaultLoggerHostnameResolver,
};
