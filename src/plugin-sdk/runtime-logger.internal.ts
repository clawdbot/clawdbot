import { format } from "node:util";
import type { OutputRuntimeEnv, RuntimeEnv } from "../runtime.js";

type LoggerLike = {
  info: (message: string) => void;
  error: (message: string) => void;
};

export function createLoggerBackedRuntime(params: {
  logger: LoggerLike;
  exitError?: (code: number) => Error;
}): OutputRuntimeEnv {
  return {
    log: (...args) => params.logger.info(format(...args)),
    error: (...args) => params.logger.error(format(...args)),
    writeStdout: (value) => params.logger.info(value),
    writeJson: (value, space = 2) =>
      params.logger.info(JSON.stringify(value, null, space > 0 ? space : undefined)),
    exit: (code: number): never => {
      throw params.exitError?.(code) ?? new Error(`exit ${code}`);
    },
  };
}

export function resolveRuntimeEnv(params: {
  runtime: RuntimeEnv;
  logger: LoggerLike;
  exitError?: (code: number) => Error;
}): RuntimeEnv;
export function resolveRuntimeEnv(params: {
  runtime?: undefined;
  logger: LoggerLike;
  exitError?: (code: number) => Error;
}): OutputRuntimeEnv;
export function resolveRuntimeEnv(params: {
  runtime?: RuntimeEnv;
  logger: LoggerLike;
  exitError?: (code: number) => Error;
}): RuntimeEnv | OutputRuntimeEnv {
  return params.runtime ?? createLoggerBackedRuntime(params);
}
