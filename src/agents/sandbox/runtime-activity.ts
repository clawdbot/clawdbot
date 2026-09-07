/** Coordinates admitted sandbox operations with destructive runtime lifecycle changes. */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createAbortError } from "../../infra/abort-signal.js";
import { sleepWithAbort } from "../../infra/backoff.js";
import {
  acquireFileLock,
  FILE_LOCK_TIMEOUT_ERROR_CODE,
  type FileLockHandle,
} from "../../infra/file-lock.js";
import { resolveGlobalMap } from "../../shared/global-singleton.js";
import type {
  SandboxBackendCommandParams,
  SandboxBackendHandle,
  SandboxBackendExecSpec,
} from "./backend-handle.types.js";
import { SANDBOX_STATE_DIR } from "./constants.js";
import type { SandboxFsBridge } from "./fs-bridge.types.js";
import { hashTextSha256 } from "./hash.js";

type RuntimeActivityLease = { release(): Promise<void> };
type RuntimeActivityState = { generation: number; retired: boolean };
type RuntimeGenerationCheck = () => Promise<void>;
type CoordinatedExec = {
  lease: RuntimeActivityLease;
  rawToken: unknown;
};

const runtimeActivityStates = resolveGlobalMap<string, RuntimeActivityState>(
  Symbol.for("openclaw.sandboxRuntimeActivityStates"),
  "close-and-restart",
);
const coordinatedExecs = new Map<object, CoordinatedExec>();
const coordinatedHandles = new WeakMap<SandboxBackendHandle, SandboxBackendHandle>();
const RETRY_MS = 25;
const STALE_MS = 60 * 60 * 1000;
const LOCK_OPTIONS = {
  retries: { retries: 0, factor: 1, minTimeout: 0, maxTimeout: 0 },
  stale: STALE_MS,
  staleRecovery: "fail-closed",
} as const;

export function resolveSandboxRuntimeActivityKey(
  backendId: string,
  runtimeId: string,
  target?: string,
): string {
  return JSON.stringify([backendId.trim().toLowerCase(), target ?? "local", runtimeId]);
}

function getRuntimeActivityState(key: string): RuntimeActivityState {
  const state = runtimeActivityStates.get(key) ?? { generation: 0, retired: false };
  runtimeActivityStates.set(key, state);
  return state;
}

function lockDirectory(): string {
  return path.join(SANDBOX_STATE_DIR, "locks", "runtime");
}

function lockPath(key: string, suffix: string): string {
  return path.join(lockDirectory(), `runtime-${hashTextSha256(key)}.${suffix}.jsonl`);
}

function runtimeActivityPath(key: string): string {
  return lockPath(key, `activity-${randomUUID()}`);
}

function isLockBusy(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === FILE_LOCK_TIMEOUT_ERROR_CODE
  );
}

async function acquireRuntimeGate(
  key: string,
  wait: boolean,
  signal?: AbortSignal,
): Promise<FileLockHandle | null> {
  while (true) {
    if (signal?.aborted) {
      throw createAbortError("Sandbox runtime operation was aborted");
    }
    try {
      return await acquireFileLock(lockPath(key, "gate"), LOCK_OPTIONS);
    } catch (error) {
      if (!isLockBusy(error)) {
        throw error;
      }
      if (!wait) {
        return null;
      }
      await sleepWithAbort(RETRY_MS, signal);
    }
  }
}

function assertLocalGeneration(key: string, generation: number): void {
  const state = getRuntimeActivityState(key);
  if (state.retired || state.generation !== generation) {
    throw new Error("Sandbox runtime was recycled before the operation started.");
  }
}

async function assertCurrentGeneration(
  key: string,
  generation: number,
  assertSharedCurrent?: RuntimeGenerationCheck,
): Promise<void> {
  assertLocalGeneration(key, generation);
  await assertSharedCurrent?.();
  assertLocalGeneration(key, generation);
}

async function acquireActivity(
  key: string,
  generation: number,
  assertSharedCurrent?: RuntimeGenerationCheck,
  signal?: AbortSignal,
  wait = true,
): Promise<RuntimeActivityLease | null> {
  await assertCurrentGeneration(key, generation, assertSharedCurrent);
  const gate = await acquireRuntimeGate(key, wait, signal);
  if (!gate) {
    return null;
  }
  let activity: FileLockHandle | undefined;
  try {
    activity = await acquireFileLock(runtimeActivityPath(key), LOCK_OPTIONS);
    await assertCurrentGeneration(key, generation, assertSharedCurrent);
    return activity;
  } catch (error) {
    await activity?.release();
    throw error;
  } finally {
    await gate.release();
  }
}

async function withRuntimeActivity<T>(
  key: string,
  generation: number,
  assertSharedCurrent: RuntimeGenerationCheck | undefined,
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  const lease = await acquireActivity(key, generation, assertSharedCurrent, signal);
  try {
    return await operation();
  } finally {
    await lease?.release();
  }
}

async function hasActiveRuntimeLease(key: string): Promise<boolean> {
  let names: string[];
  try {
    names = await fs.readdir(lockDirectory());
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
  const prefix = `runtime-${hashTextSha256(key)}.activity-`;
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(".jsonl.lock")) {
      continue;
    }
    try {
      const probe = await acquireFileLock(
        path.join(lockDirectory(), name.slice(0, -".lock".length)),
        LOCK_OPTIONS,
      );
      await probe.release();
    } catch (error) {
      if (isLockBusy(error)) {
        return true;
      }
      throw error;
    }
  }
  return false;
}

async function releaseLocks(leases: readonly FileLockHandle[]): Promise<void> {
  for (const lease of leases.toReversed()) {
    await lease.release();
  }
}

export async function tryWithSandboxRuntimeMutations<T>(
  keys: readonly string[],
  mutate: (lifecycle: { retire(): void }) => Promise<T>,
): Promise<{ acquired: false } | { acquired: true; value: T }> {
  const uniqueKeys = Array.from(new Set(keys)).toSorted();
  const leases: FileLockHandle[] = [];
  try {
    for (const key of uniqueKeys) {
      const lease = await acquireRuntimeGate(key, false);
      if (!lease) {
        return { acquired: false };
      }
      leases.push(lease);
    }
    if ((await Promise.all(uniqueKeys.map(hasActiveRuntimeLease))).some(Boolean)) {
      return { acquired: false };
    }
    const retire = () => {
      for (const key of uniqueKeys) {
        getRuntimeActivityState(key).retired = true;
      }
    };
    return { acquired: true, value: await mutate({ retire }) };
  } finally {
    await releaseLocks(leases);
  }
}

export async function tryAcquireSandboxRuntimeActivity(
  key: string,
  generation: number,
  assertSharedCurrent?: RuntimeGenerationCheck,
): Promise<RuntimeActivityLease | null> {
  return await acquireActivity(key, generation, assertSharedCurrent, undefined, false);
}

function wrapFsBridge(
  key: string,
  generation: number,
  assertSharedCurrent: RuntimeGenerationCheck | undefined,
  bridge: SandboxFsBridge,
): SandboxFsBridge {
  const wrap =
    <TParams extends { signal?: AbortSignal }, TResult>(
      operation: (params: TParams) => Promise<TResult>,
    ) =>
    async (params: TParams) =>
      await withRuntimeActivity(key, generation, assertSharedCurrent, params.signal, () =>
        operation(params),
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

export function coordinateSandboxBackendHandle(
  handle: SandboxBackendHandle,
  assertSharedCurrent?: RuntimeGenerationCheck,
): SandboxBackendHandle {
  const existing = coordinatedHandles.get(handle);
  if (existing) {
    return existing;
  }
  const key =
    handle.runtimeActivityKey ?? resolveSandboxRuntimeActivityKey(handle.id, handle.runtimeId);
  const generation = activateSandboxRuntimeActivity(key);
  const coordinated: SandboxBackendHandle = {
    ...handle,
    ...(handle.validateWorkdir
      ? {
          validateWorkdir: (workdir) =>
            withRuntimeActivity(key, generation, assertSharedCurrent, undefined, () =>
              handle.validateWorkdir!(workdir),
            ),
        }
      : {}),
    async buildExecSpec(params): Promise<SandboxBackendExecSpec> {
      const lease = await acquireActivity(key, generation, assertSharedCurrent, params.signal);
      try {
        const spec = await handle.buildExecSpec(params);
        const token = {};
        coordinatedExecs.set(token, { lease: lease!, rawToken: spec.finalizeToken });
        return { ...spec, finalizeToken: token };
      } catch (error) {
        await lease?.release();
        throw error;
      }
    },
    async finalizeExec(params) {
      const tokenObject =
        params.token && typeof params.token === "object" ? params.token : undefined;
      const token = tokenObject ? coordinatedExecs.get(tokenObject) : undefined;
      if (!token) {
        await handle.finalizeExec?.(params);
        return;
      }
      try {
        await handle.finalizeExec?.({ ...params, token: token.rawToken });
      } finally {
        if (tokenObject) {
          coordinatedExecs.delete(tokenObject);
        }
        await token.lease.release();
      }
    },
    async runShellCommand(params: SandboxBackendCommandParams) {
      return await withRuntimeActivity(key, generation, assertSharedCurrent, params.signal, () =>
        handle.runShellCommand(params),
      );
    },
    ...(handle.createFsBridge
      ? {
          createFsBridge: (params) =>
            wrapFsBridge(key, generation, assertSharedCurrent, handle.createFsBridge!(params)),
        }
      : {}),
  };
  coordinatedHandles.set(handle, coordinated);
  coordinatedHandles.set(coordinated, coordinated);
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
