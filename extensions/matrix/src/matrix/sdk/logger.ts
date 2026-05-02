import { format } from "node:util";
import { redactSensitiveText } from "openclaw/plugin-sdk/logging-core";
import type { RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";
import { getMatrixRuntime } from "../../runtime.js";

type Logger = {
  trace: (module: string, ...messageOrObject: unknown[]) => void;
  debug: (module: string, ...messageOrObject: unknown[]) => void;
  info: (module: string, ...messageOrObject: unknown[]) => void;
  warn: (module: string, ...messageOrObject: unknown[]) => void;
  error: (module: string, ...messageOrObject: unknown[]) => void;
};

export function noop(): void {
  // no-op
}

let forceConsoleLogging = false;

export function setMatrixConsoleLogging(enabled: boolean): void {
  forceConsoleLogging = enabled;
}

function resolveRuntimeLogger(module: string): RuntimeLogger | null {
  if (forceConsoleLogging) {
    return null;
  }
  try {
    return getMatrixRuntime().logging.getChildLogger({ module: `matrix:${module}` });
  } catch {
    return null;
  }
}

function formatMessage(module: string, messageOrObject: unknown[]): string {
  if (messageOrObject.length === 0) {
    return `[${module}]`;
  }
  return redactSensitiveText(`[${module}] ${format(...messageOrObject)}`);
}

export class ConsoleLogger {
  private emit(
    level: "debug" | "info" | "warn" | "error",
    module: string,
    ...messageOrObject: unknown[]
  ): void {
    const runtimeLogger = resolveRuntimeLogger(module);
    const message = formatMessage(module, messageOrObject);
    if (runtimeLogger) {
      if (level === "debug") {
        runtimeLogger.debug?.(message);
        return;
      }
      runtimeLogger[level](message);
      return;
    }
    if (level === "debug") {
      console.debug(message);
      return;
    }
    console[level](message);
  }

  trace(module: string, ...messageOrObject: unknown[]): void {
    this.emit("debug", module, ...messageOrObject);
  }

  debug(module: string, ...messageOrObject: unknown[]): void {
    this.emit("debug", module, ...messageOrObject);
  }

  info(module: string, ...messageOrObject: unknown[]): void {
    this.emit("info", module, ...messageOrObject);
  }

  warn(module: string, ...messageOrObject: unknown[]): void {
    this.emit("warn", module, ...messageOrObject);
  }

  error(module: string, ...messageOrObject: unknown[]): void {
    this.emit("error", module, ...messageOrObject);
  }
}

const defaultLogger = new ConsoleLogger();
let activeLogger: Logger = defaultLogger;

export const LogService = {
  setLogger(logger: Logger): void {
    activeLogger = logger;
  },
  trace(module: string, ...messageOrObject: unknown[]): void {
    activeLogger.trace(module, ...messageOrObject);
  },
  debug(module: string, ...messageOrObject: unknown[]): void {
    activeLogger.debug(module, ...messageOrObject);
  },
  info(module: string, ...messageOrObject: unknown[]): void {
    activeLogger.info(module, ...messageOrObject);
  },
  warn(module: string, ...messageOrObject: unknown[]): void {
    activeLogger.warn(module, ...messageOrObject);
  },
  error(module: string, ...messageOrObject: unknown[]): void {
    activeLogger.error(module, ...messageOrObject);
  },
};
