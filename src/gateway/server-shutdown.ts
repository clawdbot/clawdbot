import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { formatErrorMessage } from "../infra/errors.js";
import { createDeferredCore } from "../shared/deferred.js";
import { markGatewayRestartTrace, measureGatewayRestartTrace } from "./restart-trace.js";
import type { GatewayCloseOptions } from "./server-public.js";

/** Create a timeout promise plus cleanup hook for shutdown races. */
export function createGatewayShutdownTimeout<T>(timeoutMs: number, onTimeout: () => T) {
  const { promise, resolve } = createDeferredCore<T>();
  const timer = setTimeout(() => resolve(onTimeout()), timeoutMs);
  timer.unref?.();
  return {
    promise,
    clear: () => clearTimeout(timer),
  };
}

/** Record a shutdown warning once. */
export function recordGatewayShutdownWarning(warnings: string[], name: string): void {
  if (!warnings.includes(name)) {
    warnings.push(name);
  }
}

/** Shutdown is published before ingress closes; absent restart metadata stays absent. */
export function resolveGatewayShutdownNotice(options?: GatewayCloseOptions) {
  const restartExpectedMs = options?.restartExpectedMs;
  return {
    reason: normalizeOptionalString(options?.reason) || "gateway stopping",
    ...(typeof restartExpectedMs === "number" && Number.isFinite(restartExpectedMs)
      ? { restartExpectedMs: Math.max(0, Math.floor(restartExpectedMs)) }
      : {}),
  };
}

type GatewayShutdownStep = {
  name: string;
  run: () => Promise<void> | void;
  required?: true;
};

/** Collect owner failures, but never release dependencies beyond a failed required join. */
export async function runGatewayShutdownSteps(params: {
  steps: readonly GatewayShutdownStep[];
  onError: (message: string) => void;
}): Promise<void> {
  const errors: Error[] = [];
  for (const step of params.steps) {
    try {
      // Trace consumers parse one phase token; keep the human label for errors.
      const phase = `shutdown.${step.name.replace(/\s+/gu, "-")}`;
      markGatewayRestartTrace(`${phase}.begin`);
      await measureGatewayRestartTrace(phase, () => step.run());
    } catch (error) {
      const message = `shutdown step failed (${step.name}): ${formatErrorMessage(error)}`;
      params.onError(message);
      errors.push(new Error(message, { cause: error }));
      if (step.required) {
        break;
      }
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Gateway shutdown did not complete cleanly");
  }
}

/** Failed acquisition retains its owner when native cleanup cannot finish. */
export class GatewayStartupCleanupError extends AggregateError {
  constructor(startupError: unknown, cleanupError: unknown) {
    super([startupError, cleanupError], "Gateway startup failed and cleanup did not complete", {
      cause: startupError,
    });
    this.name = "GatewayStartupCleanupError";
  }
}

export async function rethrowGatewayStartupError(
  error: unknown,
  cleanup: () => Promise<void> | void,
): Promise<never> {
  try {
    await cleanup();
  } catch (cleanupError) {
    throw new GatewayStartupCleanupError(error, cleanupError);
  }
  throw error;
}
