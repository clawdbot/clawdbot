// Internal bridge shares the logger's resolved file target without widening its public API.
type LoggerFileTarget = { file: string; rolling: boolean };
type LoggerFileTargetResolver = () => LoggerFileTarget;

let resolveLoggerFileTarget: LoggerFileTargetResolver | undefined;

export function setLoggerFileTargetResolver(resolver: LoggerFileTargetResolver): void {
  resolveLoggerFileTarget = resolver;
}

export function getResolvedLoggerFileTarget(): LoggerFileTarget {
  if (!resolveLoggerFileTarget) {
    throw new Error("Logger file target resolver is not initialized");
  }
  return resolveLoggerFileTarget();
}
