// Shared Vitest spy helpers for repeated mock assertions.
import { vi } from "vitest";

/** Minimal mock contract for helpers that restore spies after a scoped run. */
type RestorableMock = {
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

export function mockProcessPlatform(platform: NodeJS.Platform): RestorableMock {
  return vi.spyOn(process, "platform", "get").mockReturnValue(platform);
}

export function withMockedPlatform<T>(platform: NodeJS.Platform, run: () => Promise<T>): Promise<T>;
export function withMockedPlatform<T>(platform: NodeJS.Platform, run: () => T): T;
export function withMockedPlatform<T>(
  platform: NodeJS.Platform,
  run: () => T | Promise<T>,
): T | Promise<T> {
  return withRestoredMocks([mockProcessPlatform(platform)], run);
}

export function withMockedWindowsPlatform<T>(run: () => Promise<T>): Promise<T>;
export function withMockedWindowsPlatform<T>(run: () => T): T;
export function withMockedWindowsPlatform<T>(run: () => T | Promise<T>): T | Promise<T> {
  return withMockedPlatform("win32", run);
}

const WINDOWS_ACL_ENV_KEYS = new Set([
  "fs_safe_native_mode",
  "openclaw_fs_safe_native_mode",
  "systemroot",
  "windir",
]);
const NODE_OPTIONS_ENV_KEY = "node_options";

function takeWindowsAclEnvSnapshot(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => WINDOWS_ACL_ENV_KEYS.has(key.toLowerCase())),
  );
}

function clearWindowsAclEnv(env: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(env)) {
    if (WINDOWS_ACL_ENV_KEYS.has(key.toLowerCase())) {
      delete env[key];
    }
  }
}

function forceFsSafeNativeFallback(env: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(env)) {
    const normalized = key.toLowerCase();
    if (normalized === "fs_safe_native_mode" || normalized === "openclaw_fs_safe_native_mode") {
      delete env[key];
    }
  }
  env.FS_SAFE_NATIVE_MODE = "off";
  env.OPENCLAW_FS_SAFE_NATIVE_MODE = "off";
}

function forceWindowsAclVerificationUnavailable(
  env: NodeJS.ProcessEnv,
  missingSystemRoot: string,
): void {
  clearWindowsAclEnv(env);
  // Disable the optional native backend and make both Windows ACL tool paths
  // unavailable, so permission checks exercise the real fail-closed result.
  forceFsSafeNativeFallback(env);
  env.SystemRoot = missingSystemRoot;
  env.WINDIR = missingSystemRoot;
}

export function forceNativeWindowsAclToolsUnavailable(
  env: NodeJS.ProcessEnv,
  preloadUrl: string,
): void {
  forceFsSafeNativeFallback(env);
  let existingNodeOptions: string | undefined;
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() !== NODE_OPTIONS_ENV_KEY) {
      continue;
    }
    existingNodeOptions ??= env[key];
    delete env[key];
  }
  env.NODE_OPTIONS = [existingNodeOptions, `--import=${preloadUrl}`].filter(Boolean).join(" ");
}

export function withMockedWindowsAclVerificationUnavailable<T>(
  missingSystemRoot: string,
  run: () => Promise<T>,
): Promise<T>;
export function withMockedWindowsAclVerificationUnavailable<T>(
  missingSystemRoot: string,
  run: () => T,
): T;
export function withMockedWindowsAclVerificationUnavailable<T>(
  missingSystemRoot: string,
  run: () => T | Promise<T>,
): T | Promise<T> {
  const snapshot = takeWindowsAclEnvSnapshot(process.env);
  forceWindowsAclVerificationUnavailable(process.env, missingSystemRoot);
  const restore = () => {
    clearWindowsAclEnv(process.env);
    Object.assign(process.env, snapshot);
  };
  try {
    const result = withMockedWindowsPlatform(run);
    if (isPromiseLike(result)) {
      return result.finally(restore);
    }
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}
