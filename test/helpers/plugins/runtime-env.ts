import type { OutputRuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { vi } from "vitest";

export function createRuntimeEnv(options?: { throwOnExit?: boolean }): OutputRuntimeEnv {
  const throwOnExit = options?.throwOnExit ?? true;
  return {
    log: vi.fn(),
    error: vi.fn(),
    writeStdout: vi.fn(),
    writeJson: vi.fn(),
    exit: throwOnExit
      ? vi.fn((code: number): never => {
          throw new Error(`exit ${code}`);
        })
      : vi.fn(),
  };
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Test helper lets plugin suites ascribe runtime extension shape.
export function createTypedRuntimeEnv<TRuntime>(options?: { throwOnExit?: boolean }): TRuntime {
  return createRuntimeEnv(options) as TRuntime;
}

export function createNonExitingRuntimeEnv(): OutputRuntimeEnv {
  return createRuntimeEnv({ throwOnExit: false });
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Test helper lets plugin suites ascribe runtime extension shape.
export function createNonExitingTypedRuntimeEnv<TRuntime>(): TRuntime {
  return createTypedRuntimeEnv<TRuntime>({ throwOnExit: false });
}
