import { AsyncLocalStorage } from "node:async_hooks";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { SessionMcpRuntime } from "./agent-bundle-mcp-types.js";

export type SessionMcpRuntimeCapture = (runtime: SessionMcpRuntime) => void;

type SessionMcpRuntimeRetirement = {
  retire: (runtime: SessionMcpRuntime) => Promise<boolean>;
  complete: (runtime: SessionMcpRuntime) => Promise<boolean>;
  onAsyncError?: (error: unknown) => void;
};

export type SessionMcpRuntimeCollector = {
  capture: SessionMcpRuntimeCapture;
  closeAndRetire: (retirement: SessionMcpRuntimeRetirement) => Promise<void>;
};

const runtimeCaptureStorage = new AsyncLocalStorage<SessionMcpRuntimeCapture | null>();
const log = createSubsystemLogger("agents/mcp-runtime-capture");

export function createSessionMcpRuntimeCollector(): SessionMcpRuntimeCollector {
  const claims = new Map<SessionMcpRuntime, (() => void) | undefined>();
  const retirementTasks = new Map<SessionMcpRuntime, Promise<unknown[]>>();
  let state: "open" | "retiring" | "retired" = "open";
  let retirement: SessionMcpRuntimeRetirement | undefined;
  let closePromise: Promise<void> | undefined;

  const reportAsyncError = (error: unknown) => {
    try {
      if (retirement?.onAsyncError) {
        retirement.onAsyncError(error);
        return;
      }
      log.warn(`late session MCP runtime retirement failed: ${String(error)}`);
    } catch (sinkError) {
      log.warn(
        `late session MCP runtime retirement error sink failed: ${String(sinkError)}; original error: ${String(error)}`,
      );
    }
  };

  const scheduleRetirement = (
    runtime: SessionMcpRuntime,
    release: (() => void) | undefined,
  ): Promise<unknown[]> => {
    const existing = retirementTasks.get(runtime);
    if (existing) {
      return existing;
    }
    const operations = retirement;
    if (!operations) {
      throw new Error("Session MCP runtime retirement operations are not installed");
    }
    const task = (async () => {
      const errors: unknown[] = [];
      let armed = false;
      try {
        armed = await operations.retire(runtime);
      } catch (error) {
        errors.push(error);
      }
      try {
        release?.();
      } catch (error) {
        errors.push(error);
      }
      if (armed) {
        try {
          await operations.complete(runtime);
        } catch (error) {
          errors.push(error);
        }
      }
      return errors;
    })();
    retirementTasks.set(runtime, task);
    if (state === "retired") {
      void task.then((errors) => {
        if (errors.length > 0) {
          reportAsyncError(
            new AggregateError(errors, "Failed to retire a late-captured session MCP runtime"),
          );
        }
      });
    }
    return task;
  };

  const capture: SessionMcpRuntimeCapture = (runtime) => {
    if (claims.has(runtime)) {
      return;
    }
    let release: (() => void) | undefined;
    try {
      release = runtime.acquireLease?.();
    } catch (error) {
      if (state === "open") {
        throw error;
      }
      reportAsyncError(error);
      return;
    }
    claims.set(runtime, release);
    if (state !== "open") {
      void scheduleRetirement(runtime, release);
    }
  };
  return {
    capture,
    closeAndRetire(operations) {
      if (closePromise) {
        return closePromise;
      }
      retirement = operations;
      state = "retiring";
      for (const [runtime, release] of claims) {
        void scheduleRetirement(runtime, release);
      }
      closePromise = (async () => {
        const errors: unknown[] = [];
        const observed = new Set<Promise<unknown[]>>();
        while (true) {
          const pending = [...retirementTasks.values()].filter((task) => !observed.has(task));
          if (pending.length === 0) {
            state = "retired";
            break;
          }
          pending.forEach((task) => observed.add(task));
          for (const taskErrors of await Promise.all(pending)) {
            errors.push(...taskErrors);
          }
        }
        if (errors.length > 0) {
          throw new AggregateError(errors, "Failed to retire captured session MCP runtimes");
        }
      })();
      return closePromise;
    },
  };
}

export async function withSessionMcpRuntimeCapture<T>(
  capture: SessionMcpRuntimeCapture | undefined,
  work: () => Promise<T>,
): Promise<T> {
  return await runtimeCaptureStorage.run(capture ?? null, work);
}

export async function withoutSessionMcpRuntimeCapture<T>(work: () => Promise<T>): Promise<T> {
  return await runtimeCaptureStorage.run(null, work);
}

export function captureSessionMcpRuntime(runtime: SessionMcpRuntime): void {
  runtimeCaptureStorage.getStore()?.(runtime);
}
