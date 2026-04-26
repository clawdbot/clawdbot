import { logger as matrixJsSdkRootLogger } from "matrix-js-sdk/lib/logger.js";
import { ConsoleLogger, LogService, setMatrixConsoleLogging } from "../sdk/logger.js";

let matrixSdkLoggingConfigured = false;
let matrixSdkLogMode: "default" | "quiet" = "default";
const matrixSdkBaseLogger = new ConsoleLogger();
let matrixJsSdkRootLoggerSnapshot: MatrixJsSdkRootLoggerSnapshot | null = null;

type MatrixJsSdkLogger = {
  trace: (...messageOrObject: unknown[]) => void;
  debug: (...messageOrObject: unknown[]) => void;
  info: (...messageOrObject: unknown[]) => void;
  warn: (...messageOrObject: unknown[]) => void;
  error: (...messageOrObject: unknown[]) => void;
  getChild: (namespace: string) => MatrixJsSdkLogger;
};

type MatrixJsSdkLoglevelLogger = {
  getLevel?: () => number | string;
  methodFactory?: unknown;
  rebuild?: () => void;
  setLevel?: (level: number | string, persist?: boolean) => void;
};

type MatrixJsSdkRootLoggerSnapshot = {
  level?: number | string;
  methodFactory?: unknown;
};

function shouldSuppressMatrixHttpNotFound(module: string, messageOrObject: unknown[]): boolean {
  if (!module.includes("MatrixHttpClient")) {
    return false;
  }
  return messageOrObject.some((entry) => {
    if (!entry || typeof entry !== "object") {
      return false;
    }
    return (entry as { errcode?: string }).errcode === "M_NOT_FOUND";
  });
}

export function ensureMatrixSdkLoggingConfigured(): void {
  if (!matrixSdkLoggingConfigured) {
    matrixSdkLoggingConfigured = true;
  }
  applyMatrixSdkLogger();
}

export function setMatrixSdkLogMode(mode: "default" | "quiet"): void {
  matrixSdkLogMode = mode;
  if (!matrixSdkLoggingConfigured) {
    return;
  }
  applyMatrixSdkLogger();
}

export function setMatrixSdkConsoleLogging(enabled: boolean): void {
  setMatrixConsoleLogging(enabled);
}

export function createMatrixJsSdkClientLogger(prefix = "matrix"): MatrixJsSdkLogger {
  return createMatrixJsSdkLoggerInstance(prefix);
}

function applyMatrixSdkLogger(): void {
  if (matrixSdkLogMode === "quiet") {
    setMatrixJsSdkRootLoggerLevel("silent");
    LogService.setLogger({
      trace: () => {},
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    });
    return;
  }

  setMatrixJsSdkRootLoggerLevel("debug");
  LogService.setLogger({
    trace: (module, ...messageOrObject) => matrixSdkBaseLogger.trace(module, ...messageOrObject),
    debug: (module, ...messageOrObject) => matrixSdkBaseLogger.debug(module, ...messageOrObject),
    info: (module, ...messageOrObject) => matrixSdkBaseLogger.info(module, ...messageOrObject),
    warn: (module, ...messageOrObject) => matrixSdkBaseLogger.warn(module, ...messageOrObject),
    error: (module, ...messageOrObject) => {
      if (shouldSuppressMatrixHttpNotFound(module, messageOrObject)) {
        return;
      }
      matrixSdkBaseLogger.error(module, ...messageOrObject);
    },
  });
}

function setMatrixJsSdkRootLoggerLevel(level: "debug" | "silent"): void {
  const logger = matrixJsSdkRootLogger as unknown as MatrixJsSdkLoglevelLogger;
  matrixJsSdkRootLoggerSnapshot ??= {
    level: logger.getLevel?.(),
    methodFactory: logger.methodFactory,
  };
  if (level === "silent") {
    logger.methodFactory = () => () => undefined;
    logger.setLevel?.("silent", false);
    logger.rebuild?.();
    return;
  }
  logger.methodFactory = matrixJsSdkRootLoggerSnapshot.methodFactory;
  const previousLevel = matrixJsSdkRootLoggerSnapshot.level;
  if (typeof previousLevel === "string" || typeof previousLevel === "number") {
    logger.setLevel?.(previousLevel, false);
  }
  logger.rebuild?.();
}

function createMatrixJsSdkLoggerInstance(prefix: string): MatrixJsSdkLogger {
  const log = (method: keyof ConsoleLogger, ...messageOrObject: unknown[]): void => {
    if (matrixSdkLogMode === "quiet") {
      return;
    }
    (matrixSdkBaseLogger[method] as (module: string, ...args: unknown[]) => void)(
      prefix,
      ...messageOrObject,
    );
  };

  return {
    trace: (...messageOrObject) => log("trace", ...messageOrObject),
    debug: (...messageOrObject) => log("debug", ...messageOrObject),
    info: (...messageOrObject) => log("info", ...messageOrObject),
    warn: (...messageOrObject) => log("warn", ...messageOrObject),
    error: (...messageOrObject) => {
      if (shouldSuppressMatrixHttpNotFound(prefix, messageOrObject)) {
        return;
      }
      log("error", ...messageOrObject);
    },
    getChild: (namespace: string) => {
      const nextNamespace = namespace.trim();
      return createMatrixJsSdkLoggerInstance(nextNamespace ? `${prefix}.${nextNamespace}` : prefix);
    },
  };
}
