import { vi } from "vitest";

export type RestorableMock = {
  mockRestore(): void;
};

function restoreMocks(mocks: readonly RestorableMock[]): void {
  for (const mock of mocks.toReversed()) {
    mock.mockRestore();
  }
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Promise<T>).finally === "function"
  );
}

export function withRestoredMocks<T>(
  mocks: readonly RestorableMock[],
  run: () => Promise<T>,
): Promise<T>;
export function withRestoredMocks<T>(mocks: readonly RestorableMock[], run: () => T): T;
export function withRestoredMocks<T>(
  mocks: readonly RestorableMock[],
  run: () => T | Promise<T>,
): T | Promise<T> {
  try {
    const result = run();
    if (isPromiseLike(result)) {
      return result.finally(() => restoreMocks(mocks));
    }
    restoreMocks(mocks);
    return result;
  } catch (error) {
    restoreMocks(mocks);
    throw error;
  }
}

export function withMockedPlatform<T>(platform: NodeJS.Platform, run: () => Promise<T>): Promise<T>;
export function withMockedPlatform<T>(platform: NodeJS.Platform, run: () => T): T;
export function withMockedPlatform<T>(
  platform: NodeJS.Platform,
  run: () => T | Promise<T>,
): T | Promise<T> {
  return withRestoredMocks([vi.spyOn(process, "platform", "get").mockReturnValue(platform)], run);
}

export function withMockedWindowsPlatform<T>(run: () => Promise<T>): Promise<T>;
export function withMockedWindowsPlatform<T>(run: () => T): T;
export function withMockedWindowsPlatform<T>(run: () => T | Promise<T>): T | Promise<T> {
  return withMockedPlatform("win32", run);
}
