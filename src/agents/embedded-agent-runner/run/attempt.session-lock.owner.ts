import { clampTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { toErrorObject } from "../../../infra/errors.js";
import { resolveGlobalSingleton } from "../../../shared/global-singleton.js";
import { resolveEmbeddedSessionFileKey } from "../session-file-key.js";
import { resetSessionFileFenceStateForTest } from "./attempt.session-lock.fence-controller.js";

type SessionFileOwnerWaiter = {
  resolve: () => void;
  reject: (error: unknown) => void;
  timer?: NodeJS.Timeout;
  abortListener?: () => void;
  signal?: AbortSignal;
};

type SessionFileOwnerEntry = {
  ownerId: symbol;
  waiters: Set<SessionFileOwnerWaiter>;
};

type SessionFileOwnerState = {
  owners: Map<string, SessionFileOwnerEntry>;
};

const EMBEDDED_ATTEMPT_SESSION_FILE_OWNER_STATE_KEY = Symbol.for(
  "openclaw.embeddedAttemptSessionFileOwnerState",
);

const sessionFileOwnerState = resolveGlobalSingleton(
  EMBEDDED_ATTEMPT_SESSION_FILE_OWNER_STATE_KEY,
  (): SessionFileOwnerState => ({
    owners: new Map<string, SessionFileOwnerEntry>(),
  }),
);

export type EmbeddedAttemptSessionFileOwner = {
  sessionFileKey: string;
  release(): void;
};

class EmbeddedAttemptSessionFileOwnerTimeoutError extends Error {
  constructor(sessionFile: string, timeoutMs: number) {
    super(`timed out waiting for embedded session file owner after ${timeoutMs}ms: ${sessionFile}`);
    this.name = "EmbeddedAttemptSessionFileOwnerTimeoutError";
  }
}

function abortReason(signal: AbortSignal): unknown {
  return "reason" in signal ? (signal as { reason?: unknown }).reason : undefined;
}

function abortOwnerWaitReason(signal: AbortSignal): unknown {
  return abortReason(signal) ?? new Error("operation aborted", { cause: signal });
}

function resolveSessionFileOwnerWaitTimeoutMs(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs === undefined) {
    return undefined;
  }
  return clampTimerTimeoutMs(timeoutMs);
}

function waitForSessionFileOwnerRelease(params: {
  sessionFile: string;
  entry: SessionFileOwnerEntry;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<void> {
  if (params.signal?.aborted) {
    return Promise.reject(
      toErrorObject(abortOwnerWaitReason(params.signal), "Non-Error rejection"),
    );
  }
  return new Promise<void>((resolve, reject) => {
    const waiter: SessionFileOwnerWaiter = {
      resolve,
      reject,
      signal: params.signal,
    };
    const cleanup = () => {
      params.entry.waiters.delete(waiter);
      if (waiter.timer) {
        clearTimeout(waiter.timer);
      }
      if (waiter.signal && waiter.abortListener) {
        waiter.signal.removeEventListener("abort", waiter.abortListener);
      }
    };
    waiter.resolve = () => {
      cleanup();
      resolve();
    };
    waiter.reject = (error) => {
      cleanup();
      reject(toErrorObject(error, "Non-Error rejection"));
    };
    const timeoutMs = resolveSessionFileOwnerWaitTimeoutMs(params.timeoutMs);
    if (timeoutMs !== undefined) {
      waiter.timer = setTimeout(() => {
        waiter.reject(
          new EmbeddedAttemptSessionFileOwnerTimeoutError(params.sessionFile, timeoutMs),
        );
      }, timeoutMs);
      waiter.timer.unref?.();
    }
    if (params.signal) {
      waiter.abortListener = () => {
        waiter.reject(abortOwnerWaitReason(params.signal!));
      };
      params.signal.addEventListener("abort", waiter.abortListener, { once: true });
    }
    params.entry.waiters.add(waiter);
  });
}

export async function acquireEmbeddedAttemptSessionFileOwner(params: {
  sessionFile: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<EmbeddedAttemptSessionFileOwner> {
  const sessionFileKey = resolveEmbeddedSessionFileKey(params.sessionFile);
  const ownerId = Symbol(sessionFileKey);
  while (true) {
    if (params.signal?.aborted) {
      throw abortOwnerWaitReason(params.signal);
    }
    const entry = sessionFileOwnerState.owners.get(sessionFileKey);
    if (!entry) {
      sessionFileOwnerState.owners.set(sessionFileKey, {
        ownerId,
        waiters: new Set(),
      });
      return {
        sessionFileKey,
        release() {
          const current = sessionFileOwnerState.owners.get(sessionFileKey);
          if (!current || current.ownerId !== ownerId) {
            return;
          }
          sessionFileOwnerState.owners.delete(sessionFileKey);
          for (const waiter of current.waiters) {
            waiter.resolve();
          }
        },
      };
    }
    await waitForSessionFileOwnerRelease({
      sessionFile: params.sessionFile,
      entry,
      timeoutMs: params.timeoutMs,
      signal: params.signal,
    });
  }
}

function resetEmbeddedAttemptSessionFileOwnersForTest(): void {
  for (const entry of sessionFileOwnerState.owners.values()) {
    for (const waiter of entry.waiters) {
      waiter.reject(
        new Error("embedded attempt session file owners reset", {
          cause: "resetEmbeddedAttemptSessionFileOwnersForTest",
        }),
      );
    }
  }
  sessionFileOwnerState.owners.clear();
  resetSessionFileFenceStateForTest();
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.embeddedAttemptSessionFileOwnersTestApi")
  ] = { resetEmbeddedAttemptSessionFileOwnersForTest };
}
