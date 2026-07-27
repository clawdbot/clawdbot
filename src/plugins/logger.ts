// Builds plugin-scoped loggers for runtime and setup code.
import type { PluginLogger } from "./types.js";

type LoggerLike = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
  debug?: (message: string) => void;
};

/** Adapts a generic logger to the plugin loader logger interface. */
export function createPluginLoaderLogger(logger: LoggerLike): PluginLogger {
  return {
    info: (msg) => logger.info(msg),
    warn: (msg) => logger.warn(msg),
    error: (msg) => logger.error(msg),
    debug: (msg) => logger.debug?.(msg),
  };
}
