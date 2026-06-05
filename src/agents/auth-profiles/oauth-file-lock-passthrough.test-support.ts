/**
 * Passthrough file-lock mocks for OAuth tests.
 * Avoids real interprocess locking so store operations remain deterministic in
 * single-process Vitest cases.
 */
import { vi } from "vitest";

vi.mock("../../infra/file-lock.js", () => ({
  resetFileLockStateForTest: () => undefined,
  withFileLock: async <T>(_filePath: string, _options: unknown, run: () => Promise<T>) => run(),
}));

vi.mock("../../plugin-sdk/file-lock.js", () => ({
  resetFileLockStateForTest: () => undefined,
  withFileLock: async <T>(_filePath: string, _options: unknown, run: () => Promise<T>) => run(),
}));
