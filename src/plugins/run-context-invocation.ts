/**
 * Invocation-bound plugin run-context capability controller.
 *
 * The host constructs one capability per (runId, pluginId) for a single
 * invocation. A reference-counted window enforces the callback window: access is
 * allowed only while the owning callback is running (for async callbacks, until
 * the returned promise settles), and is `FORBIDDEN` afterwards, including for
 * background work that outlives the callback.
 */
import {
  compareAndConsumePluginRunContext,
  getPluginRunContext,
  isPluginRunClosed,
  setPluginRunContext,
} from "./host-hook-runtime.js";
import {
  isPluginJsonValue,
  type PluginJsonValue,
  type PluginRunContextInvocation,
} from "./host-hooks.js";

export type PluginRunContextInvocationController = PluginRunContextInvocation & {
  /** Opens the capability window for the duration of `run` (sync or async). */
  withActive<T>(run: () => T): T;
};

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return false;
  }
  return "then" in value && typeof value.then === "function";
}

export function createPluginRunContextInvocation(params: {
  runId: string;
  pluginId: string;
}): PluginRunContextInvocationController {
  const { runId, pluginId } = params;
  const window = { depth: 0 };

  function activeGate(): { status: "OK" } | { status: "FORBIDDEN" } | { status: "CLOSED_RUN" } {
    if (window.depth === 0) {
      return { status: "FORBIDDEN" };
    }
    if (isPluginRunClosed(runId)) {
      return { status: "CLOSED_RUN" };
    }
    return { status: "OK" };
  }

  const invocation: PluginRunContextInvocation = {
    set(namespace, value: PluginJsonValue) {
      const gate = activeGate();
      if (gate.status !== "OK") {
        return gate;
      }
      if (!isPluginJsonValue(value)) {
        return { status: "INVALID" };
      }
      return setPluginRunContext({ pluginId, patch: { runId, namespace, value } })
        ? { status: "OK" }
        : { status: "INVALID" };
    },
    get(namespace: string) {
      const gate = activeGate();
      if (gate.status !== "OK") {
        return gate;
      }
      const value = getPluginRunContext({ pluginId, get: { runId, namespace } });
      return value === undefined ? { status: "NOT_FOUND" } : { status: "OK", value };
    },
    compareAndConsume(namespace: string, expected: PluginJsonValue) {
      const gate = activeGate();
      if (gate.status !== "OK") {
        return gate;
      }
      return compareAndConsumePluginRunContext({ runId, pluginId, namespace, expected });
    },
  };

  return {
    ...invocation,
    withActive<T>(run: () => T): T {
      window.depth += 1;
      let result: T;
      try {
        result = run();
      } catch (error) {
        window.depth -= 1;
        throw error;
      }
      if (isPromiseLike(result)) {
        const cleanup = () => {
          window.depth -= 1;
        };
        // Attach cleanup to both settlement paths without replacing the promise
        // returned to the caller, so a rejecting callback never produces an
        // additional unobserved rejection from the cleanup chain.
        void Promise.resolve(result).then(cleanup, cleanup);
        return result;
      }
      window.depth -= 1;
      return result;
    },
  };
}
