import { vi } from "vitest";
import type { OutputRuntimeEnv } from "../runtime.js";
import type { MockFn } from "../test-utils/vitest-mock-fn.js";

export type CliMockOutputRuntime = OutputRuntimeEnv & {
  log: MockFn<OutputRuntimeEnv["log"]>;
  error: MockFn<OutputRuntimeEnv["error"]>;
  exit: MockFn<OutputRuntimeEnv["exit"]>;
  writeJson: MockFn<OutputRuntimeEnv["writeJson"]>;
  writeStdout: MockFn<OutputRuntimeEnv["writeStdout"]>;
};

export type CliRuntimeCapture = {
  runtimeLogs: string[];
  runtimeErrors: string[];
  defaultRuntime: CliMockOutputRuntime;
  resetRuntimeCapture: () => void;
};

type MockCallsWithFirstArg = {
  mock: {
    calls: Array<[unknown, ...unknown[]]>;
  };
};

function normalizeRuntimeStdout(value: string): string {
  return value.endsWith("\n") ? value.slice(0, -1) : value;
}

function stringifyRuntimeJson(value: unknown, space = 2): string {
  return JSON.stringify(value, null, space > 0 ? space : undefined);
}

export function createCliRuntimeCapture(): CliRuntimeCapture {
  const runtimeLogs: string[] = [];
  const runtimeErrors: string[] = [];
  const stringifyArgs = (args: unknown[]) => args.map((value) => String(value)).join(" ");
  const defaultRuntime: CliMockOutputRuntime = {
    log: vi.fn((...args: unknown[]) => {
      runtimeLogs.push(stringifyArgs(args));
    }),
    error: vi.fn((...args: unknown[]) => {
      runtimeErrors.push(stringifyArgs(args));
    }),
    writeStdout: vi.fn((value: string) => {
      defaultRuntime.log(normalizeRuntimeStdout(value));
    }),
    writeJson: vi.fn((value: unknown, space = 2) => {
      defaultRuntime.log(stringifyRuntimeJson(value, space));
    }),
    exit: vi.fn((code: number) => {
      throw new Error(`__exit__:${code}`);
    }),
  };
  return {
    runtimeLogs,
    runtimeErrors,
    defaultRuntime,
    resetRuntimeCapture: () => {
      runtimeLogs.length = 0;
      runtimeErrors.length = 0;
    },
  };
}

export async function mockRuntimeModule<TModule extends { defaultRuntime: OutputRuntimeEnv }>(
  loadActual: () => Promise<TModule>,
  defaultRuntime: TModule["defaultRuntime"],
): Promise<TModule> {
  const actual = await loadActual();
  return {
    ...actual,
    defaultRuntime: {
      ...actual.defaultRuntime,
      ...defaultRuntime,
    },
  };
}

export function spyRuntimeLogs(runtime: Pick<OutputRuntimeEnv, "log">) {
  return vi.spyOn(runtime, "log").mockImplementation(() => {});
}

export function spyRuntimeErrors(runtime: Pick<OutputRuntimeEnv, "error">) {
  return vi.spyOn(runtime, "error").mockImplementation(() => {});
}

export function spyRuntimeJson(runtime: Pick<OutputRuntimeEnv, "writeJson">) {
  return vi.spyOn(runtime, "writeJson").mockImplementation(() => {});
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Test helper lets callers ascribe captured JSON shape.
export function firstWrittenJsonArg<T>(writeJson: MockCallsWithFirstArg): T | null {
  return (writeJson.mock.calls[0]?.[0] ?? null) as T | null;
}
