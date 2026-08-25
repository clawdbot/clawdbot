/** Coordinates live container operations with destructive runtime lifecycle changes. */
import { createAbortError } from "../../infra/abort-signal.js";
import { resolveGlobalMap } from "../../shared/global-singleton.js";
import type { SandboxContainerEngine, SandboxContainerEngineTarget } from "./container-engine.js";

export type SandboxContainerActivityLease = { release(): void };

type ContainerActivityWaiter = {
  kind: "activity" | "mutation";
  signal?: AbortSignal;
  resolve: (lease: SandboxContainerActivityLease) => void;
  reject: (error: Error) => void;
  abort?: () => void;
};

type ContainerActivityState = {
  readers: number;
  writer: boolean;
  waiters: ContainerActivityWaiter[];
};

const containerActivityStates = resolveGlobalMap<string, ContainerActivityState>(
  Symbol.for("openclaw.sandboxContainerActivityStates"),
  "close-and-restart",
);

export function resolveSandboxContainerActivityKey(
  engine: SandboxContainerEngine,
  containerName: string,
  target?: SandboxContainerEngineTarget,
): string {
  return `${engine.id}:${target?.key ?? "local"}:${containerName}`;
}

function releaseContainerActivity(
  key: string,
  state: ContainerActivityState,
  kind: ContainerActivityWaiter["kind"],
): SandboxContainerActivityLease {
  let released = false;
  return {
    release() {
      if (released) {
        return;
      }
      released = true;
      if (kind === "mutation") {
        state.writer = false;
      } else {
        state.readers -= 1;
      }
      drainContainerActivity(key, state);
    },
  };
}

function drainContainerActivity(key: string, state: ContainerActivityState): void {
  while (!state.writer && state.waiters.length > 0) {
    const waiter = state.waiters[0];
    if (!waiter) {
      break;
    }
    if (waiter.kind === "mutation" && state.readers > 0) {
      return;
    }
    state.waiters.shift();
    if (waiter.abort) {
      waiter.signal?.removeEventListener("abort", waiter.abort);
    }
    if (waiter.signal?.aborted) {
      waiter.reject(createAbortError("Sandbox container operation was aborted"));
      continue;
    }
    if (waiter.kind === "mutation") {
      state.writer = true;
    } else {
      state.readers += 1;
    }
    waiter.resolve(releaseContainerActivity(key, state, waiter.kind));
  }
  if (!state.writer && state.readers === 0 && state.waiters.length === 0) {
    containerActivityStates.delete(key);
  }
}

async function acquireContainerActivity(
  key: string,
  kind: ContainerActivityWaiter["kind"],
  signal?: AbortSignal,
): Promise<SandboxContainerActivityLease> {
  if (signal?.aborted) {
    throw createAbortError("Sandbox container operation was aborted");
  }
  let state = containerActivityStates.get(key);
  if (!state) {
    state = { readers: 0, writer: false, waiters: [] };
    containerActivityStates.set(key, state);
  }
  const current = state;
  return await new Promise<SandboxContainerActivityLease>((resolve, reject) => {
    const waiter: ContainerActivityWaiter = { kind, signal, resolve, reject };
    waiter.abort = () => {
      const index = current.waiters.indexOf(waiter);
      if (index >= 0) {
        current.waiters.splice(index, 1);
        reject(createAbortError("Sandbox container operation was aborted"));
        drainContainerActivity(key, current);
      }
    };
    current.waiters.push(waiter);
    signal?.addEventListener("abort", waiter.abort, { once: true });
    if (signal?.aborted) {
      waiter.abort();
      return;
    }
    drainContainerActivity(key, current);
  });
}

export async function acquireSandboxContainerActivity(
  key: string,
  signal?: AbortSignal,
): Promise<SandboxContainerActivityLease> {
  return await acquireContainerActivity(key, "activity", signal);
}

export function tryAcquireSandboxContainerActivity(
  key: string,
): SandboxContainerActivityLease | null {
  let state = containerActivityStates.get(key);
  if (!state) {
    state = { readers: 0, writer: false, waiters: [] };
    containerActivityStates.set(key, state);
  }
  if (state.writer || state.waiters.length > 0) {
    return null;
  }
  state.readers += 1;
  return releaseContainerActivity(key, state, "activity");
}

export async function withSandboxContainerMutation<T>(
  key: string,
  mutate: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const mutation = await acquireContainerActivity(key, "mutation", signal);
  try {
    return await mutate();
  } finally {
    mutation.release();
  }
}
