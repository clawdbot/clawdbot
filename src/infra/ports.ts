// Checks gateway port usage and reports listener diagnostics.
import { danger, info, shouldLogVerbose, warn } from "../globals.js";
import { logDebug } from "../logger.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { isErrno } from "./errors.js";
import { formatPortDiagnostics } from "./ports-format.js";
import { inspectPortUsage } from "./ports-inspect.js";
import { tryListenOnPort } from "./ports-probe.js";
import type { PortConnection, PortListener, PortUsage, PortUsageStatus } from "./ports-types.js";

class PortInUseError extends Error {
  port: number;
  details?: string;

  constructor(port: number, details?: string) {
    super(`Port ${port} is already in use.`);
    this.name = "PortInUseError";
    this.port = port;
    this.details = details;
  }
}

export async function describePortOwner(port: number): Promise<string | undefined> {
  const diagnostics = await inspectPortUsage(port);
  if (diagnostics.listeners.length === 0) {
    return undefined;
  }
  return formatPortDiagnostics(diagnostics).join("\n");
}

/** Probes Node's wildcard bind by default; callers may scope checks to their owned interface. */
export async function ensurePortAvailable(port: number, host?: string): Promise<void> {
  // Detect EADDRINUSE early with a friendly message.
  try {
    const probe = host ? { port, host } : { port };
    await tryListenOnPort(probe);
  } catch (err) {
    if (isErrno(err) && err.code === "EADDRINUSE") {
      throw new PortInUseError(port);
    }
    throw err;
  }
}

export async function handlePortError(
  err: unknown,
  port: number,
  context: string,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<never> {
  // Uniform messaging for EADDRINUSE with optional owner details.
  if (err instanceof PortInUseError || (isErrno(err) && err.code === "EADDRINUSE")) {
    const details =
      err instanceof PortInUseError
        ? (err.details ?? (await describePortOwner(port)))
        : await describePortOwner(port);
    runtime.error(danger(`${context} failed: port ${port} is already in use.`));
    if (details) {
      runtime.error(info("Port listener details:"));
      runtime.error(details);
      if (/openclaw|src\/index\.ts|dist\/index\.js/.test(details)) {
        runtime.error(
          warn(
            "It looks like another OpenClaw instance is already running. Stop it or pick a different port.",
          ),
        );
      }
    }
    runtime.error(
      info("Resolve by stopping the process using the port or passing --port <free-port>."),
    );
    runtime.exit(1);
  }
  runtime.error(danger(`${context} failed: ${String(err)}`));
  if (shouldLogVerbose()) {
    const stdout = (err as { stdout?: string })?.stdout;
    const stderr = (err as { stderr?: string })?.stderr;
    if (stdout?.trim()) {
      logDebug(`stdout: ${stdout.trim()}`);
    }
    if (stderr?.trim()) {
      logDebug(`stderr: ${stderr.trim()}`);
    }
  }
  runtime.exit(1);
  throw new Error("unreachable");
}

export { PortInUseError };
export type { PortConnection, PortListener, PortUsage, PortUsageStatus };
export {
  classifyPortListener,
  formatPortDiagnostics,
  isDualStackLoopbackGatewayListeners,
  isExpectedGatewayListeners,
} from "./ports-format.js";
export { inspectPortConnections, inspectPortUsage } from "./ports-inspect.js";
