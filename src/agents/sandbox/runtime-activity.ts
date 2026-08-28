/** Coordinates admitted sandbox operations with destructive runtime lifecycle changes. */
import { randomUUID } from "node:crypto";
import { createAbortError } from "../../infra/abort-signal.js";
import { resolveGlobalMap } from "../../shared/global-singleton.js";
import type {
  SandboxBackendCommandParams,
  SandboxBackendHandle,
  SandboxBackendExecSpec,
} from "./backend-handle.types.js";
import type { SandboxFsBridge } from "./fs-bridge.types.js";

type RuntimeActivityLease = { release(): void };
type RuntimeActivityWaiter = {
  kind: "activity" | "mutation";
  generation?: number;
  signal?: AbortSignal;
  resolve: (lease: RuntimeActivityLease) => void;
  reject: (error: Error) => void;
  abort?: () => void;
};
type RuntimeActivityState = {
  readers: number;
  writer: boolean;
  waiters: RuntimeActivityWaiter[];
  generation: number;
  retired: boolean;
  handles: number;
};
type CoordinatedExec = {
  key: string;
  lease: RuntimeActivityLease;
  rawToken: unknown;
  released: boolean;
  marker: string;
};

const runtimeActivityStates = resolveGlobalMap<string, RuntimeActivityState>(
  Symbol.for("openclaw.sandboxRuntimeActivityStates"),
  "close-and-restart",
);
const coordinatedExecs = new Map<object, CoordinatedExec>();
const coordinatedHandles = new WeakMap<SandboxBackendHandle, SandboxBackendHandle>();
const handleFinalizer = new FinalizationRegistry<{ key: string; state: RuntimeActivityState }>(
  ({ key, state }) => {
    state.handles -= 1;
    if (
      runtimeActivityStates.get(key) === state &&
      !state.writer &&
      state.readers === 0 &&
      state.waiters.length === 0 &&
      state.handles === 0
    ) {
      runtimeActivityStates.delete(key);
    }
  },
);

export function resolveSandboxRuntimeActivityKey(
  backendId: string,
  runtimeId: string,
  target?: string,
): string {
  return JSON.stringify([backendId.trim().toLowerCase(), target ?? "local", runtimeId]);
}

function getRuntimeActivityState(key: string): RuntimeActivityState {
  const state = runtimeActivityStates.get(key) ?? {
    readers: 0,
    writer: false,
    waiters: [],
    generation: 0,
    retired: false,
    handles: 0,
  };
  runtimeActivityStates.set(key, state);
  return state;
}

function releaseRuntimeActivity(
  key: string,
  state: RuntimeActivityState,
  kind: RuntimeActivityWaiter["kind"],
): RuntimeActivityLease {
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
      drainRuntimeActivity(key, state);
    },
  };
}

function drainRuntimeActivity(key: string, state: RuntimeActivityState): void {
  while (!state.writer && state.waiters.length > 0) {
    const waiter = state.waiters[0];
    if (!waiter || (waiter.kind === "mutation" && state.readers > 0)) {
      return;
    }
    state.waiters.shift();
    if (waiter.abort) {
      waiter.signal?.removeEventListener("abort", waiter.abort);
    }
    if (waiter.signal?.aborted) {
      waiter.reject(createAbortError("Sandbox runtime operation was aborted"));
      continue;
    }
    if (waiter.kind === "activity" && (state.retired || waiter.generation !== state.generation)) {
      waiter.reject(new Error("Sandbox runtime was recycled before the operation started."));
      continue;
    }
    if (waiter.kind === "mutation") {
      state.writer = true;
    } else {
      state.readers += 1;
    }
    waiter.resolve(releaseRuntimeActivity(key, state, waiter.kind));
  }
  if (
    !state.retired &&
    !state.writer &&
    state.readers === 0 &&
    state.waiters.length === 0 &&
    state.handles === 0
  ) {
    runtimeActivityStates.delete(key);
  }
}

async function acquireRuntimeActivity(
  key: string,
  kind: RuntimeActivityWaiter["kind"],
  signal?: AbortSignal,
  generation?: number,
): Promise<RuntimeActivityLease> {
  if (signal?.aborted) {
    throw createAbortError("Sandbox runtime operation was aborted");
  }
  const state = getRuntimeActivityState(key);
  if (kind === "activity" && (state.retired || generation !== state.generation)) {
    throw new Error("Sandbox runtime was recycled before the operation started.");
  }
  return await new Promise<RuntimeActivityLease>((resolve, reject) => {
    const waiter: RuntimeActivityWaiter = { kind, generation, signal, resolve, reject };
    waiter.abort = () => {
      const index = state.waiters.indexOf(waiter);
      if (index >= 0) {
        state.waiters.splice(index, 1);
        reject(createAbortError("Sandbox runtime operation was aborted"));
        drainRuntimeActivity(key, state);
      }
    };
    state.waiters.push(waiter);
    signal?.addEventListener("abort", waiter.abort, { once: true });
    if (signal?.aborted) {
      waiter.abort();
      return;
    }
    drainRuntimeActivity(key, state);
  });
}

export async function withSandboxRuntimeMutations<T>(
  keys: readonly string[],
  mutate: (lifecycle: { retire(): void }) => Promise<T>,
): Promise<T> {
  const uniqueKeys = Array.from(new Set(keys)).toSorted();
  const leases: RuntimeActivityLease[] = [];
  try {
    for (const key of uniqueKeys) {
      leases.push(await acquireRuntimeActivity(key, "mutation"));
    }
    return await mutate({
      retire() {
        for (const key of uniqueKeys) {
          const state = getRuntimeActivityState(key);
          state.retired = true;
          drainRuntimeActivity(key, state);
        }
      },
    });
  } finally {
    for (const lease of leases.toReversed()) {
      lease.release();
    }
  }
}

export function tryAcquireSandboxRuntimeActivity(
  key: string,
  generation: number,
): RuntimeActivityLease | null {
  const state = getRuntimeActivityState(key);
  if (
    state.retired ||
    generation !== state.generation ||
    state.writer ||
    state.waiters.length > 0
  ) {
    return null;
  }
  state.readers += 1;
  return releaseRuntimeActivity(key, state, "activity");
}

async function withRuntimeActivity<T>(
  key: string,
  generation: number,
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  const lease = await acquireRuntimeActivity(key, "activity", signal, generation);
  try {
    return await operation();
  } finally {
    lease.release();
  }
}

function wrapFsBridge(key: string, generation: number, bridge: SandboxFsBridge): SandboxFsBridge {
  const wrap =
    <TParams extends { signal?: AbortSignal }, TResult>(
      operation: (params: TParams) => Promise<TResult>,
    ) =>
    async (params: TParams) =>
      await withRuntimeActivity(
        key,
        generation,
        params.signal,
        async () => await operation(params),
      );
  return {
    resolvePath: (params) => bridge.resolvePath(params),
    readFile: wrap(bridge.readFile.bind(bridge)),
    ...(bridge.copyFile ? { copyFile: wrap(bridge.copyFile.bind(bridge)) } : {}),
    writeFile: wrap(bridge.writeFile.bind(bridge)),
    ...(bridge.createFileExclusive
      ? { createFileExclusive: wrap(bridge.createFileExclusive.bind(bridge)) }
      : {}),
    mkdirp: wrap(bridge.mkdirp.bind(bridge)),
    remove: wrap(bridge.remove.bind(bridge)),
    rename: wrap(bridge.rename.bind(bridge)),
    stat: wrap(bridge.stat.bind(bridge)),
  };
}

export function coordinateSandboxBackendHandle(handle: SandboxBackendHandle): SandboxBackendHandle {
  const existing = coordinatedHandles.get(handle);
  if (existing) {
    return existing;
  }
  const key =
    handle.runtimeActivityKey ?? resolveSandboxRuntimeActivityKey(handle.id, handle.runtimeId);
  const generation = activateSandboxRuntimeActivity(key);
  const state = getRuntimeActivityState(key);
  const coordinated: SandboxBackendHandle = {
    ...handle,
    ...(handle.validateWorkdir
      ? {
          validateWorkdir: (workdir) =>
            withRuntimeActivity(key, generation, undefined, () => handle.validateWorkdir!(workdir)),
        }
      : {}),
    async buildExecSpec(params): Promise<SandboxBackendExecSpec> {
      const lease = await acquireRuntimeActivity(key, "activity", params.signal, generation);
      try {
        const marker = randomUUID();
        const spec = await handle.buildExecSpec({
          ...params,
          env: { ...params.env, SANDBOX_EXEC_OWNER_ID: marker },
        });
        const token = {};
        coordinatedExecs.set(token, {
          key,
          lease,
          marker,
          rawToken: spec.finalizeToken,
          released: false,
        });
        return { ...spec, finalizeToken: token };
      } catch (error) {
        lease.release();
        throw error;
      }
    },
    async finalizeExec(params) {
      const token =
        params.token && typeof params.token === "object"
          ? coordinatedExecs.get(params.token)
          : undefined;
      if (!token) {
        await handle.finalizeExec?.(params);
        return;
      }
      try {
        await handle.finalizeExec?.({ ...params, token: token.rawToken });
      } finally {
        if (!token.released) {
          token.released = true;
          token.lease.release();
        }
        coordinatedExecs.delete(params.token as object);
      }
    },
    terminateExec: async (token: unknown) => {
      const execution =
        token && typeof token === "object" ? coordinatedExecs.get(token) : undefined;
      if (!execution || execution.released) {
        return;
      }
      if (handle.terminateExec) {
        await handle.terminateExec(execution.rawToken);
        return;
      }
      const result = await handle.runShellCommand({
        script: TERMINATE_EXEC_DESCENDANTS_SCRIPT,
        args: [`SANDBOX_EXEC_OWNER_ID=${execution.marker}`],
        allowFailure: true,
        activityToken: execution.rawToken,
      });
      if (result.code !== 0) {
        const detail =
          result.stderr.toString("utf8").trim() || result.stdout.toString("utf8").trim();
        throw new Error(detail || `Sandbox process tree cleanup failed with code ${result.code}.`);
      }
    },
    async runShellCommand(params: SandboxBackendCommandParams) {
      const inherited =
        params.activityToken && typeof params.activityToken === "object"
          ? coordinatedExecs.get(params.activityToken)
          : undefined;
      if (inherited?.key === key && !inherited.released) {
        return await handle.runShellCommand({ ...params, activityToken: inherited.rawToken });
      }
      return await withRuntimeActivity(key, generation, params.signal, () =>
        handle.runShellCommand(params),
      );
    },
    ...(handle.createFsBridge
      ? {
          createFsBridge: (params) => wrapFsBridge(key, generation, handle.createFsBridge!(params)),
        }
      : {}),
  };
  coordinatedHandles.set(handle, coordinated);
  coordinatedHandles.set(coordinated, coordinated);
  state.handles += 1;
  handleFinalizer.register(coordinated, { key, state });
  return coordinated;
}

export function activateSandboxRuntimeActivity(key: string): number {
  const state = getRuntimeActivityState(key);
  if (state.retired) {
    state.retired = false;
    state.generation += 1;
  }
  return state.generation;
}

const TERMINATE_EXEC_DESCENDANTS_SCRIPT = String.raw`
command -v tr >/dev/null 2>&1 || exit 0
[ -d /proc ] || exit 0
find_owned_pids() {
  for env_file in /proc/[0-9]*/environ; do
    if [ -r "$env_file" ] && tr '\0' '\n' < "$env_file" 2>/dev/null | grep -Fqx "$1"; then
      basename "$(dirname "$env_file")"
    fi
  done
}
owned="$(find_owned_pids "$1")"
[ -z "$owned" ] && exit 0
kill -TERM $owned 2>/dev/null || true
sleep 1
owned="$(find_owned_pids "$1")"
[ -z "$owned" ] || kill -KILL $owned 2>/dev/null || true
sleep 1
owned="$(find_owned_pids "$1")"
[ -z "$owned" ] || { echo "Sandbox process IDs survived SIGKILL: $owned" >&2; exit 1; }
`.trim();
