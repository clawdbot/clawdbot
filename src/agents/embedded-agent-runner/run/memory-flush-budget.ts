import type { OperationalRunInstanceRef } from "../../admitted-run-context.js";
import {
  DAILY_MEMORY_FLUSH_MAX_APPEND_CHARS,
  memoryFlushAppendRejected,
} from "../../memory-flush-append.js";

type MemoryFlushAppendCommit<T> = Readonly<{
  appendChars: number;
  commit: () => Promise<T>;
}>;

export type MemoryFlushAppendEnforcement = <T>(request: MemoryFlushAppendCommit<T>) => Promise<T>;

const memoryFlushAppendEnforcementByRun = new WeakMap<
  OperationalRunInstanceRef,
  MemoryFlushAppendEnforcement
>();

/** Creates one opaque, serialized append-budget capability. Mutable counters stay closure-owned. */
export function createMemoryFlushAppendEnforcement(): MemoryFlushAppendEnforcement {
  let acceptedChars = 0;
  let tail: Promise<void> = Promise.resolve();

  return async <T>(request: MemoryFlushAppendCommit<T>): Promise<T> => {
    const operation = tail.then(async () => {
      const cumulativeChars = acceptedChars + request.appendChars;
      if (cumulativeChars > DAILY_MEMORY_FLUSH_MAX_APPEND_CHARS) {
        throw memoryFlushAppendRejected(
          `content across this memory-flush run is too large (${cumulativeChars} chars; max ${DAILY_MEMORY_FLUSH_MAX_APPEND_CHARS}). Write 1-3 short pointer lines only.`,
        );
      }

      const result = await request.commit();
      acceptedChars = cumulativeChars;
      return result;
    });
    tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return await operation;
  };
}

/** Allocates at most one append budget for the exact admitted logical run. */
export function initializeMemoryFlushAppendBudget(owner: OperationalRunInstanceRef): void {
  if (!memoryFlushAppendEnforcementByRun.has(owner)) {
    memoryFlushAppendEnforcementByRun.set(owner, createMemoryFlushAppendEnforcement());
  }
}

/** Internal tool-construction lookup; never returns mutable budget state. */
export function resolveMemoryFlushAppendEnforcement(
  owner: OperationalRunInstanceRef,
): MemoryFlushAppendEnforcement | undefined {
  return memoryFlushAppendEnforcementByRun.get(owner);
}
