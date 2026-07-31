/** Non-blocking worker-thread writer for Gateway audit metadata. */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { resolveStateDir } from "../config/paths.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "../state/openclaw-state-db.js";
import type { AuditEventInput } from "./audit-event-types.js";

const MAX_PENDING_AUDIT_EVENTS = 4_096;
// The worker can be synchronously blocked inside SQLite's busy timeout. Keep
// shutdown beyond that window so a queued stop cannot kill an accepted write.
const AUDIT_WRITER_SHUTDOWN_TIMEOUT_MS = OPENCLAW_SQLITE_BUSY_TIMEOUT_MS + 5_000;

type AuditWriterMessage =
  | { type: "ready" }
  | { type: "recorded" }
  | { type: "record-error"; error: string }
  | { type: "maintenance-error"; error: string }
  | { type: "stopped" };

export type AuditEventWriter = {
  ready: Promise<void>;
  record: (input: AuditEventInput) => boolean;
  stop: () => Promise<void>;
};

function resolveAuditEventWriterUrl(currentModuleUrl = import.meta.url): URL {
  const currentPath = fileURLToPath(currentModuleUrl);
  const normalized = currentPath.replaceAll(path.sep, "/");
  const distMarker = "/dist/";
  const distIndex = normalized.lastIndexOf(distMarker);
  if (distIndex >= 0) {
    const distRoot = currentPath.slice(0, distIndex + distMarker.length);
    return pathToFileURL(path.join(distRoot, "audit", "audit-event-writer.worker.js"));
  }
  const extension = path.extname(currentPath) || ".js";
  return new URL(`./audit-event-writer.worker${extension}`, currentModuleUrl);
}

/** Start one bounded worker queue. SQLite contention never blocks the agent-event callback. */
export function createAuditEventWriter(
  options: {
    stateDir?: string;
    maxPending?: number;
    workerUrl?: URL;
    onError?: (error: string) => void;
  } = {},
): AuditEventWriter {
  const workerUrl = options.workerUrl ?? resolveAuditEventWriterUrl();
  const sourceWorkerExecArgv = workerUrl.pathname.endsWith(".ts") ? ["--import", "tsx"] : undefined;
  const maxPending = Math.max(1, Math.floor(options.maxPending ?? MAX_PENDING_AUDIT_EVENTS));
  let worker: Worker;
  try {
    worker = new Worker(workerUrl, {
      workerData: { stateDir: options.stateDir ?? resolveStateDir(process.env) },
      execArgv: sourceWorkerExecArgv,
    });
  } catch (error) {
    options.onError?.(error instanceof Error ? error.message : String(error));
    return {
      ready: Promise.resolve(),
      record: () => false,
      stop: async () => {},
    };
  }
  worker.unref?.();

  let pending = 0;
  let stopped = false;
  let unavailable = false;
  let readyResolved = false;
  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  let resolveStop: (() => void) | undefined;
  let stopTimer: ReturnType<typeof setTimeout> | undefined;

  const markReady = () => {
    if (!readyResolved) {
      readyResolved = true;
      resolveReady();
    }
  };
  const finishStop = () => {
    if (stopTimer) {
      clearTimeout(stopTimer);
      stopTimer = undefined;
    }
    const finish = resolveStop;
    resolveStop = undefined;
    finish?.();
  };
  const fail = (error: unknown) => {
    options.onError?.(error instanceof Error ? error.message : String(error));
  };

  worker.on("message", (message: AuditWriterMessage) => {
    switch (message.type) {
      case "ready":
        markReady();
        return;
      case "recorded":
        pending = Math.max(0, pending - 1);
        return;
      case "record-error":
        pending = Math.max(0, pending - 1);
        fail(message.error);
        return;
      case "maintenance-error":
        fail(message.error);
        return;
      case "stopped":
        pending = 0;
        markReady();
        finishStop();
    }
  });
  worker.on("error", (error) => {
    unavailable = true;
    fail(error);
    markReady();
    finishStop();
  });
  worker.on("exit", (code) => {
    unavailable = true;
    if (!stopped) {
      fail(`audit event writer exited with code ${code}`);
    }
    markReady();
    finishStop();
  });

  return {
    ready,
    record: (input) => {
      if (stopped || unavailable || pending >= maxPending) {
        if (!stopped) {
          fail(
            unavailable
              ? "audit event writer is unavailable; dropping metadata"
              : `audit event queue is full (${maxPending}); dropping metadata`,
          );
        }
        return false;
      }
      pending += 1;
      try {
        // Node Worker.postMessage is not the browser Window API and has no targetOrigin.
        // oxlint-disable-next-line unicorn/require-post-message-target-origin
        worker.postMessage({ type: "record", input });
        return true;
      } catch (error) {
        pending -= 1;
        unavailable = true;
        fail(error);
        return false;
      }
    },
    stop: async () => {
      if (stopped) {
        return;
      }
      stopped = true;
      if (unavailable) {
        return;
      }
      await new Promise<void>((resolve) => {
        resolveStop = resolve;
        stopTimer = setTimeout(() => {
          fail("audit event writer shutdown timed out; pending metadata may be lost");
          void worker.terminate();
          finishStop();
        }, AUDIT_WRITER_SHUTDOWN_TIMEOUT_MS);
        try {
          // Node Worker.postMessage is not the browser Window API and has no targetOrigin.
          // oxlint-disable-next-line unicorn/require-post-message-target-origin
          worker.postMessage({ type: "stop" });
        } catch (error) {
          fail(error);
          finishStop();
        }
      });
    },
  };
}
