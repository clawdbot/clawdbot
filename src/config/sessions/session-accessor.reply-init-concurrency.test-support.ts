// Cross-process concurrency handshake: spawns one long-lived child worker per test file
// (paying tsx/module cold-start once) and drives request/ready/proceed/result round trips
// against it so tests can inject a foreign commit between the worker's read and its write.
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { createConcurrencyWorkerScript } from "./session-accessor.reply-init-concurrency.worker-script.test-support.js";

export {
  AGENT_ID,
  SESSION_KEY,
} from "./session-accessor.reply-init-concurrency.worker-script.test-support.js";

type ChildResult =
  | {
      ok: true;
      sessionEntry: {
        sessionFile?: string;
        sessionId?: string;
        updatedAt?: number;
      };
    }
  | {
      currentEntry?: {
        sessionId?: string;
        updatedAt?: number;
      };
      ok: false;
      reason: string;
      revision: string;
    };

type TranscriptRewriteChildResult =
  | { ok: true }
  | {
      message: string;
      name: string;
      ok: false;
    };

// Shared by sync-append-race and sync-rewrite-race: both report whether the
// rewrite step was rejected by the atomic-snapshot conflict guard.
type SyncAppendRaceChildResult =
  | { ok: true; rewriteRejected: boolean }
  | {
      message: string;
      name: string;
      ok: false;
    };

type SyncRewriteRaceChildResult = SyncAppendRaceChildResult;

// Drives a real SessionManager raw (non-message) append on an already-open,
// non-empty transcript and reports whether that append rejected when a foreign
// row raced the gap between open() and the append.
type SyncRawAppendRaceChildResult =
  | { appendRejected: boolean; ok: true }
  | {
      message: string;
      name: string;
      ok: false;
    };

// Drives the real SessionManager first-record path on an empty transcript and
// reports whether the deferred-header fold rejected the append when a foreign
// row raced the handshake gap. When `retryAfterConflict` is set, it also reports
// whether a retry on the SAME manager instance succeeds after the conflict --
// proving the manager reloaded durable state instead of repeating the conflict.
type SyncInitialHeaderRaceChildResult =
  | { appendRejected: boolean; ok: true; retrySucceeded?: boolean }
  | {
      message: string;
      name: string;
      ok: false;
    };

type ConcurrencyWorkerRequest =
  | {
      kind: "reply-init";
      preparedUpdatedAt: number;
      storePath: string;
    }
  | {
      kind: "transcript-rewrite";
      rewriteMode: "read-then-replace" | "replace-twice";
      sessionId: string;
      storePath: string;
    }
  | {
      kind: "sync-transcript-rewrite";
      sessionId: string;
      storePath: string;
      targetEntryId: string;
    }
  | {
      kind: "sync-append-race";
      sessionId: string;
      storePath: string;
      useAtomicSnapshot: boolean;
    }
  | {
      kind: "sync-rewrite-race";
      sessionId: string;
      storePath: string;
      useAtomicSnapshot: boolean;
    }
  | {
      kind: "sync-raw-append-race";
      sessionId: string;
      storePath: string;
    }
  | {
      kind: "sync-initial-header-race";
      retryAfterConflict?: boolean;
      sessionId: string;
      storePath: string;
    };

type ConcurrencyWorkerReady<TRequest extends ConcurrencyWorkerRequest> = TRequest extends {
  kind: "reply-init";
}
  ? { currentEntry?: unknown; revision: string }
  : { eventCount: number };

type ConcurrencyWorkerResult<TRequest extends ConcurrencyWorkerRequest> = TRequest extends {
  kind: "reply-init";
}
  ? ChildResult
  : TRequest extends { kind: "sync-append-race" }
    ? SyncAppendRaceChildResult
    : TRequest extends { kind: "sync-rewrite-race" }
      ? SyncRewriteRaceChildResult
      : TRequest extends { kind: "sync-raw-append-race" }
        ? SyncRawAppendRaceChildResult
        : TRequest extends { kind: "sync-initial-header-race" }
          ? SyncInitialHeaderRaceChildResult
          : TranscriptRewriteChildResult;

type ConcurrencyWorkerMessage =
  | { phase: "booted" }
  | { error: { message: string; name: string }; phase: "error"; requestId: number }
  | { phase: "ready"; requestId: number; value: unknown }
  | { phase: "result"; requestId: number; value: unknown };

// Cold tsx/module loading competes with other CI shards. Pay that cost once
// with a process-start budget, while keeping each concurrency handshake tight.
export const WORKER_BOOT_TIMEOUT_MS = 30_000;
const SCENARIO_TIMEOUT_MS = 10_000;
// Preserve the OS-process boundary while paying tsx/module startup once per file.
// Every request still uses an isolated store path.
let concurrencyWorker: ReturnType<typeof spawn> | undefined;
let nextRequestId = 0;

function isWorkerMessage(message: unknown): message is ConcurrencyWorkerMessage {
  return typeof message === "object" && message !== null && "phase" in message;
}

async function waitForWorkerBoot(child: ReturnType<typeof spawn>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("timeout waiting for concurrency worker startup"));
    }, WORKER_BOOT_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("error", onError);
      child.off("exit", onExit);
      child.off("message", onMessage);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        new Error(
          `concurrency worker exited during startup code=${String(code)} signal=${String(signal)}`,
        ),
      );
    };
    const onMessage = (message: unknown) => {
      if (!isWorkerMessage(message) || message.phase !== "booted") {
        return;
      }
      cleanup();
      resolve();
    };
    child.once("error", onError);
    child.once("exit", onExit);
    child.on("message", onMessage);
  });
}

export async function getConcurrencyWorker(): Promise<ReturnType<typeof spawn>> {
  if (concurrencyWorker) {
    return concurrencyWorker;
  }
  const sessionAccessorUrl = pathToFileURL(
    path.resolve("src/config/sessions/session-accessor.ts"),
  ).href;
  const sessionManagerUrl = pathToFileURL(
    path.resolve("src/agents/sessions/session-manager.ts"),
  ).href;
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      createConcurrencyWorkerScript(sessionAccessorUrl, sessionManagerUrl),
    ],
    { stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  try {
    await waitForWorkerBoot(child);
  } catch (error) {
    child.kill();
    throw error;
  }
  concurrencyWorker = child;
  return child;
}

export async function runConcurrencyScenario<TRequest extends ConcurrencyWorkerRequest>(
  request: TRequest,
  onReady: (value: ConcurrencyWorkerReady<TRequest>) => Promise<void> | void,
): Promise<ConcurrencyWorkerResult<TRequest>> {
  const child = await getConcurrencyWorker();
  const requestId = ++nextRequestId;
  return await new Promise<ConcurrencyWorkerResult<TRequest>>((resolve, reject) => {
    let readyHandled = false;
    const timeout = setTimeout(() => {
      fail(new Error(`timeout waiting for concurrency worker ${request.kind}`));
    }, SCENARIO_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("error", onError);
      child.off("exit", onExit);
      child.off("message", onMessage);
    };
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onError = (error: Error) => fail(error);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      fail(new Error(`concurrency worker exited code=${String(code)} signal=${String(signal)}`));
    };
    const onMessage = (message: unknown) => {
      if (
        !isWorkerMessage(message) ||
        !("requestId" in message) ||
        message.requestId !== requestId
      ) {
        return;
      }
      if (message.phase === "error") {
        const error = new Error(message.error.message);
        error.name = message.error.name;
        fail(error);
        return;
      }
      if (message.phase === "ready" && !readyHandled) {
        readyHandled = true;
        void Promise.resolve(onReady(message.value as ConcurrencyWorkerReady<TRequest>)).then(
          () => {
            child.send({ kind: "proceed", requestId }, (error) => {
              if (error) {
                fail(error);
              }
            });
          },
          fail,
        );
        return;
      }
      if (message.phase === "result") {
        cleanup();
        resolve(message.value as ConcurrencyWorkerResult<TRequest>);
      }
    };
    child.once("error", onError);
    child.once("exit", onExit);
    child.on("message", onMessage);
    child.send({ ...request, requestId }, (error) => {
      if (error) {
        fail(error);
      }
    });
  });
}

export async function waitForChild(child: ReturnType<typeof spawn>, label: string): Promise<void> {
  let childStdout = "";
  let childStderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => {
    childStdout += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    childStderr += String(chunk);
  });

  // The child can exit immediately before this waiter attaches. Honor an
  // already-observed exit or the test will wait forever for a spent event.
  const childExit =
    child.exitCode !== null || child.signalCode !== null
      ? { code: child.exitCode, signal: child.signalCode }
      : await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
          (resolve, reject) => {
            child.once("error", reject);
            child.once("exit", (code, signal) => resolve({ code, signal }));
          },
        );
  if (childExit.code !== 0) {
    throw new Error(
      `${label} child failed code=${String(childExit.code)} signal=${String(childExit.signal)}\nstdout:\n${childStdout}\nstderr:\n${childStderr}`,
    );
  }
}

/** Shuts down the shared concurrency worker if one was started for this test file. */
export async function shutdownConcurrencyWorker(): Promise<void> {
  const child = concurrencyWorker;
  concurrencyWorker = undefined;
  if (!child) {
    return;
  }
  if (child.exitCode === null && child.signalCode === null) {
    child.send({ kind: "shutdown" });
  }
  await waitForChild(child, "concurrency worker shutdown");
}
