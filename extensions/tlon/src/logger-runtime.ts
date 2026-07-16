import { format } from "node:util";

type RuntimeLoggerLike = {
  info: (message: string) => void;
  error: (message: string) => void;
};

type LoggerBackedRuntime = {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  writeStdout: (value: string) => void;
  writeJson: (value: unknown, space?: number) => void;
  exit: (code: number) => never;
};

export function createLoggerBackedRuntime(params: {
  logger: RuntimeLoggerLike;
  exitError?: (code: number) => Error;
}): LoggerBackedRuntime {
  return {
    log: (...args) => {
      params.logger.info(format(...args));
    },
    error: (...args) => {
      params.logger.error(format(...args));
    },
    writeStdout: (value) => {
      params.logger.info(value);
    },
    writeJson: (value, space = 2) => {
      params.logger.info(JSON.stringify(value, null, space > 0 ? space : undefined));
    },
    exit: (code: number): never => {
      throw params.exitError?.(code) ?? new Error(`exit ${code}`);
    },
  };
}
