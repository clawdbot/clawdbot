// Test helpers for command runtime/config fixtures.
// Kept under commands because many command tests need the same mock runtime shapes.

import { vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import type { MockFn } from "../test-utils/vitest-mock-fn.js";

export const baseConfigSnapshot = {
  path: "/tmp/openclaw.json",
  exists: true,
  raw: "{}",
  parsed: {},
  valid: true,
  config: {},
  issues: [],
  legacyIssues: [],
};

type TestRuntime = {
  log: MockFn<RuntimeEnv["log"]>;
  error: MockFn<RuntimeEnv["error"]>;
  exit: MockFn<RuntimeEnv["exit"]>;
};

type CapturingTestRuntime = {
  runtime: RuntimeEnv;
  logs: string[];
  errors: string[];
};

/** Creates a mocked runtime whose calls can be asserted by Vitest tests. */
export function createTestRuntime(): TestRuntime {
  const log = vi.fn() as MockFn<RuntimeEnv["log"]>;
  const error = vi.fn() as MockFn<RuntimeEnv["error"]>;
  const exit = vi.fn((_: number) => undefined) as MockFn<RuntimeEnv["exit"]>;
  return {
    log,
    error,
    exit,
  };
}

/** Creates a runtime that captures log/error strings in arrays. */
export function createCapturingTestRuntime(): CapturingTestRuntime {
  const logs: string[] = [];
  const errors: string[] = [];
  const runtime = {
    log: (message: unknown) => logs.push(String(message)),
    error: (message: unknown) => errors.push(String(message)),
    exit: (_code?: number) => undefined,
  };
  return { runtime, logs, errors };
}

/** Creates a runtime that throws on exit so tests can assert early termination. */
export function createThrowingTestRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(() => {
      throw new Error("exit");
    }),
  };
}
