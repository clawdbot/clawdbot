// Shared gateway startup tracing for the entry wrapper and CLI dispatcher.
import process from "node:process";
import { isTruthyEnvValue } from "../infra/env.js";

type GatewayStartupTraceSource = "entry" | "cli.main";
type GatewayStartupTraceLineFormatter = (message: string) => string;

export function createGatewayStartupTrace(
  argv: string[],
  source: GatewayStartupTraceSource,
): {
  enabled: boolean;
  setLineFormatter(formatter: GatewayStartupTraceLineFormatter): void;
  mark(name: string): void;
  measure<T>(name: string, run: () => T | PromiseLike<T>): Promise<T>;
} {
  const enabled =
    isTruthyEnvValue(process.env.OPENCLAW_GATEWAY_STARTUP_TRACE) &&
    argv.slice(2).includes("gateway");
  const started = performance.now();
  let last = started;
  let lineFormatter: GatewayStartupTraceLineFormatter | null = null;
  let pendingMessages: string[] = [];
  const flushPending = (formatter: GatewayStartupTraceLineFormatter) => {
    const queued = pendingMessages;
    pendingMessages = [];
    for (const message of queued) {
      process.stderr.write(`${formatter(message)}\n`);
    }
  };
  const flushPendingPlainOnExit = () => {
    if (!lineFormatter) {
      flushPending((message) => message);
    }
  };
  if (enabled) {
    // Direct process.exit paths cannot await config-backed formatting. Never
    // silently lose explicitly requested trace records on an unknown early exit.
    process.once("exit", flushPendingPlainOnExit);
  }
  const writeMessage = (message: string) => {
    if (!lineFormatter) {
      pendingMessages.push(message);
      return;
    }
    process.stderr.write(`${lineFormatter(message)}\n`);
  };
  const emit = (name: string, durationMs: number, totalMs: number) => {
    if (!enabled) {
      return;
    }
    writeMessage(
      `[gateway] startup trace: ${source}.${name} ${durationMs.toFixed(1)}ms total=${totalMs.toFixed(1)}ms`,
    );
  };
  return {
    enabled,
    setLineFormatter(formatter) {
      lineFormatter = formatter;
      process.off("exit", flushPendingPlainOnExit);
      flushPending(formatter);
    },
    mark(name: string) {
      const now = performance.now();
      emit(name, now - last, now - started);
      last = now;
    },
    async measure<T>(name: string, run: () => T | PromiseLike<T>): Promise<T> {
      const before = performance.now();
      try {
        return await run();
      } finally {
        const now = performance.now();
        emit(name, now - before, now - started);
        last = now;
      }
    },
  };
}

export async function configureGatewayStartupTraceConsoleFormatting(
  trace: ReturnType<typeof createGatewayStartupTrace>,
): Promise<void> {
  if (!trace.enabled) {
    return;
  }
  const { formatConsoleDiagnosticLine } = await import("../logging/json-console-line.js");
  trace.setLineFormatter((message) => formatConsoleDiagnosticLine({ level: "info", message }));
}
