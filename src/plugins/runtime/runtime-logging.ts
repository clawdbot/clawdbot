// Runtime logging helpers route plugin runtime logs through OpenClaw verbosity controls.
import { shouldLogVerbose } from "../../globals.js";
import { getChildLogger, isFileLogLevelEnabled } from "../../logging.js";
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

type RuntimeLogMethod = "debug" | "info" | "warn" | "error";

/** Creates the plugin runtime logging facade. */
export function createRuntimeLogging(): PluginRuntime["logging"] {
  return {
    shouldLogVerbose,
    getChildLogger: (bindings, opts) => {
      const overrideLevel = opts?.level ? normalizeLogLevel(opts.level) : undefined;
      const childOpts = overrideLevel ? { level: overrideLevel } : undefined;
      // Resolve the child logger per call: tslog snapshots a sublogger's min level at
      // creation, so a long-lived plugin logger (e.g. a channel monitor) would keep
      // dropping writes after the log level is raised at runtime even though
      // shouldLogVerbose() reports the new level. Skip the pre-gate when an override is
      // set since it may be more permissive than the current file level.
      const emit =
        (level: RuntimeLogMethod) => (message: string, meta?: Record<string, unknown>) => {
          if (!overrideLevel && !isFileLogLevelEnabled(level)) {
            return;
          }
          const logger = getChildLogger(bindings, childOpts);
          writeRuntimeLog(logger[level].bind(logger), message, meta);
        };
      return {
        debug: emit("debug"),
        info: emit("info"),
        warn: emit("warn"),
        error: emit("error"),
      };
    },
  };
}
