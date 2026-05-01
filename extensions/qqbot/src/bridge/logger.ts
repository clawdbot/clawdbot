/**
 * Bridge-layer logger — holds the framework logger injected at gateway startup.
 *
 * Bridge modules (approval, tools, etc.) use this instead of `console.log` or
 * engine's `debugLog` so that all logs flow through the OpenClaw log system.
 */

interface BridgeLogger {
  info: (msg: string) => void;
  error: (msg: string) => void;
  warn?: (msg: string) => void;
  debug?: (msg: string) => void;
}

let _logger: BridgeLogger | null = null;

/** Register the framework logger. Called once in startGateway(). */
export function setBridgeLogger(logger: BridgeLogger): void {
  _logger = logger;
}

/** Get the bridge logger. Falls back to console if not yet registered. */
export function getBridgeLogger(): BridgeLogger {
  return (
    _logger ?? {
      info: (msg) => console.log(msg),
      error: (msg) => console.error(msg),
      debug: (msg) => console.log(msg),
    }
  );
}
