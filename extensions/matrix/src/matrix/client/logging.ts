import { logger as matrixJsSdkRootLogger } from "matrix-js-sdk/lib/logger.js";
import { ConsoleLogger, LogService, setMatrixConsoleLogging } from "../sdk/logger.js";

let matrixSdkLoggingConfigured = false;
let matrixSdkLogMode: "default" | "quiet" = "default";
const matrixSdkBaseLogger = new ConsoleLogger();
const matrixSdkSilentMethodFactory = () => () => {};
let matrixSdkRootMethodFactory: unknown;
let matrixSdkRootLoggerInitialized = false;

type MatrixJsSdkLogger = {
  trace: (...messageOrObject: unknown[]) => void;
  debug: (...messageOrObject: unknown[]) => void;
  info: (...messageOrObject: unknown[]) => void;
  warn: (...messageOrObject: unknown[]) => void;
  error: (...messageOrObject: unknown[]) => void;
  getChild: (namespace: string) => MatrixJsSdkLogger;
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

function applyMatrixJsSdkRootLoggerMode(): void {
  const rootLogger = matrixJsSdkRootLogger as {
    methodFactory?: unknown;
    rebuild?: () => void;
  };
  if (!matrixSdkRootLoggerInitialized) {
    matrixSdkRootMethodFactory = rootLogger.methodFactory;
    matrixSdkRootLoggerInitialized = true;
  }
  rootLogger.methodFactory =
    matrixSdkLogMode === "quiet" ? matrixSdkSilentMethodFactory : matrixSdkRootMethodFactory;
  rootLogger.rebuild?.();
}

function applyMatrixSdkLogger(): void {
  applyMatrixJsSdkRootLoggerMode();
  if (matrixSdkLogMode === "quiet") {
    LogService.setLogger({
      trace: () => {},
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    });
    return;
  }

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
