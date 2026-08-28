/**
 * Passthrough file-lock mocks for OAuth tests.
 * Avoids real interprocess locking so store operations remain deterministic in
 * single-process Vitest cases.
 */
import { afterAll, vi } from "vitest";

const fileLockPassthroughMock = vi.hoisted(() => ({
  drainFileLockStateForTest: async () => undefined,
  resetFileLockStateForTest: () => undefined,
  withFileLock: async <T>(_filePath: string, _options: unknown, run: () => Promise<T>) => run(),
}));

vi.mock("../../infra/file-lock.js", () => fileLockPassthroughMock);
vi.mock("../../plugin-sdk/file-lock.js", () => fileLockPassthroughMock);

afterAll(() => {
  vi.doUnmock("../../infra/file-lock.js");
  vi.doUnmock("../../plugin-sdk/file-lock.js");
  vi.resetModules();
});
