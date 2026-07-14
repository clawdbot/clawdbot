// Shared gateway startup tracing for the entry wrapper and CLI dispatcher.
import process from "node:process";
import { isTruthyEnvValue } from "../infra/env.js";

type GatewayStartupTraceSource = "entry" | "cli.main";

export function createGatewayStartupTrace(
  argv: string[],
  source: GatewayStartupTraceSource,
): {
  mark(name: string): void;
  measure<T>(name: string, run: () => T | PromiseLike<T>): Promise<T>;
} {
  const enabled =
    isTruthyEnvValue(process.env.OPENCLAW_GATEWAY_STARTUP_TRACE) &&
    argv.slice(2).includes("gateway");
  const started = performance.now();
  let last = started;
  const emit = (name: string, durationMs: number, totalMs: number) => {
    if (!enabled) {
      return;
    }
    process.stderr.write(
      `[gateway] startup trace: ${source}.${name} ${durationMs.toFixed(1)}ms total=${totalMs.toFixed(1)}ms\n`,
    );
  };
  return {
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
