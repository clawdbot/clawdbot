// Memory Core coordinates published-index readers with atomic shadow publication.
import { resolveUserPath } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import {
  acquireMemorySqliteWriterLease,
  tryAcquireMemorySqliteLease,
  type MemorySqliteLeaseHandle,
} from "./manager-sqlite-lease.js";
type Waiter = {
  kind: "read" | "write";
  resolve: (release: () => void) => void;
};

type GenerationLeaseState = {
  readers: number;
  writer: boolean;
  queue: Waiter[];
};

const states = new Map<string, GenerationLeaseState>();
const CROSS_PROCESS_RETRY_DELAY_MS = 25;

function createGenerationLeaseAbortError(signal?: AbortSignal): Error {
  return new Error("Memory index generation lease acquisition aborted", { cause: signal?.reason });
}

function throwIfGenerationLeaseAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createGenerationLeaseAbortError(signal);
  }
}

async function acquireCrossProcessLease(
  databasePath: string,
  kind: Waiter["kind"],
  signal?: AbortSignal,
): Promise<MemorySqliteLeaseHandle> {
  const acquireSqliteLease = async (
    location: string,
    mode: "shared" | "exclusive",
  ): Promise<MemorySqliteLeaseHandle> => {
    while (true) {
      throwIfGenerationLeaseAborted(signal);
      const lease = tryAcquireMemorySqliteLease(location, mode);
      if (lease) {
        if (signal?.aborted) {
          lease.release();
          throw createGenerationLeaseAbortError(signal);
        }
        return lease;
      }
      try {
        await sleepWithAbort(CROSS_PROCESS_RETRY_DELAY_MS, signal);
      } catch (err) {
        throw signal?.aborted ? createGenerationLeaseAbortError(signal) : err;
      }
    }
  };

  // Admission prevents new readers from overtaking a waiting publisher across
  // processes. Readers release it as soon as their generation lease is secured.
  const admissionLocation = `${databasePath}.generation-writer.sqlite`;
  let admission: MemorySqliteLeaseHandle;
  try {
    admission =
      kind === "read"
        ? await acquireSqliteLease(admissionLocation, "shared")
        : await acquireMemorySqliteWriterLease(admissionLocation, signal);
  } catch (err) {
    throw signal?.aborted ? createGenerationLeaseAbortError(signal) : err;
  }
  let generation: MemorySqliteLeaseHandle;
  try {
    generation = await acquireSqliteLease(
      `${databasePath}.generation-lock.sqlite`,
      kind === "read" ? "shared" : "exclusive",
    );
  } catch (err) {
    admission.release();
    throw err;
  }
  if (kind === "read") {
    try {
      admission.release();
    } catch (err) {
      generation.release();
      throw err;
    }
    if (signal?.aborted) {
      generation.release();
      throw createGenerationLeaseAbortError(signal);
    }
    return generation;
  }
  return {
    release: () => {
      try {
        generation.release();
      } finally {
        admission.release();
      }
    },
  };
}

function stateFor(key: string): GenerationLeaseState {
  const existing = states.get(key);
  if (existing) {
    return existing;
  }
  const created = { readers: 0, writer: false, queue: [] };
  states.set(key, created);
  return created;
}

function drain(key: string, state: GenerationLeaseState): void {
  if (state.writer) {
    return;
  }
  if (state.readers > 0) {
    // Readers already in the current generation may admit more readers until a
    // writer reaches the queue head. Readers behind that writer wait for the next generation.
    while (state.queue[0]?.kind === "read") {
      const reader = state.queue.shift()!;
      state.readers += 1;
      reader.resolve(() => {
        state.readers -= 1;
        drain(key, state);
      });
    }
    return;
  }
  const first = state.queue.shift();
  if (!first) {
    states.delete(key);
    return;
  }
  if (first.kind === "write") {
    state.writer = true;
    first.resolve(() => {
      state.writer = false;
      drain(key, state);
    });
    return;
  }
  const readers = [first];
  while (state.queue[0]?.kind === "read") {
    readers.push(state.queue.shift()!);
  }
  state.readers = readers.length;
  for (const reader of readers) {
    reader.resolve(() => {
      state.readers -= 1;
      drain(key, state);
    });
  }
}

async function acquireLocal(
  key: string,
  kind: Waiter["kind"],
  signal?: AbortSignal,
): Promise<() => void> {
  throwIfGenerationLeaseAborted(signal);
  const state = stateFor(key);
  return await new Promise<() => void>((resolve, reject) => {
    let admitted = false;
    const waiter: Waiter = {
      kind,
      resolve: (release) => {
        admitted = true;
        signal?.removeEventListener("abort", onAbort);
        if (signal?.aborted) {
          release();
          reject(createGenerationLeaseAbortError(signal));
          return;
        }
        resolve(release);
      },
    };
    const onAbort = () => {
      if (admitted) {
        return;
      }
      const index = state.queue.indexOf(waiter);
      if (index < 0) {
        return;
      }
      state.queue.splice(index, 1);
      signal?.removeEventListener("abort", onAbort);
      drain(key, state);
      reject(createGenerationLeaseAbortError(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    state.queue.push(waiter);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    drain(key, state);
  });
}

async function acquire(
  databasePath: string,
  kind: Waiter["kind"],
  signal?: AbortSignal,
): Promise<() => void> {
  const key = resolveUserPath(databasePath);
  const releaseLocal = await acquireLocal(key, kind, signal);
  let crossProcess: MemorySqliteLeaseHandle;
  try {
    throwIfGenerationLeaseAborted(signal);
    crossProcess = await acquireCrossProcessLease(key, kind, signal);
    if (signal?.aborted) {
      crossProcess.release();
      throw createGenerationLeaseAbortError(signal);
    }
  } catch (err) {
    releaseLocal();
    throw err;
  }
  return () => {
    try {
      crossProcess.release();
    } finally {
      releaseLocal();
    }
  };
}

async function withLease<T>(key: string, kind: Waiter["kind"], run: () => Promise<T>): Promise<T> {
  const release = await acquire(key, kind);
  try {
    return await run();
  } finally {
    release();
  }
}

export async function acquireMemoryIndexReadGeneration(
  databasePath: string,
  signal?: AbortSignal,
): Promise<() => void> {
  return await acquire(databasePath, "read", signal);
}

export async function withMemoryIndexPublishGeneration<T>(
  databasePath: string,
  run: () => Promise<T>,
): Promise<T> {
  return await withLease(databasePath, "write", run);
}
