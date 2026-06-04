import { vi } from "vitest";

// OAuth tests do not need real interprocess file locks; passthrough mocks keep
// store operations synchronous and deterministic.
vi.mock("../../infra/file-lock.js", () => ({
  resetFileLockStateForTest: () => undefined,
  withFileLock: async <T>(_filePath: string, _options: unknown, run: () => Promise<T>) => run(),
}));

vi.mock("../../plugin-sdk/file-lock.js", () => ({
  resetFileLockStateForTest: () => undefined,
  withFileLock: async <T>(_filePath: string, _options: unknown, run: () => Promise<T>) => run(),
}));
