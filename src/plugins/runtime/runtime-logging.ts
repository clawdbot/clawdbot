import { shouldLogVerbose } from "../../globals.js";
import { getChildLogger } from "../../logging.js";
import { normalizeLogLevel } from "../../logging/levels.js";
import type { PluginRuntime } from "./types.js";

function writeRuntimeLog(
  log: (...args: unknown[]) => void,
  message: string,
  meta?: Record<string, unknown>,
): void {
  if (meta && Object.keys(meta).length > 0) {
    log(meta, message);
    return;
  }
  log(message);
}

export function createRuntimeLogging(): PluginRuntime["logging"] {
  return {
    shouldLogVerbose,
    getChildLogger: (bindings, opts) => {
      const logger = getChildLogger(bindings, {
        level: opts?.level ? normalizeLogLevel(opts.level) : undefined,
      });
      return {
        debug: (message, meta) => {
          if (logger.debug) {
            writeRuntimeLog(logger.debug.bind(logger), message, meta);
          }
        },
        info: (message, meta) => writeRuntimeLog(logger.info.bind(logger), message, meta),
        warn: (message, meta) => writeRuntimeLog(logger.warn.bind(logger), message, meta),
        error: (message, meta) => writeRuntimeLog(logger.error.bind(logger), message, meta),
      };
    },
  };
}
