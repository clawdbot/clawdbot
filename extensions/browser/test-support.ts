/**
 * Browser test-support re-exports from shared plugin-sdk test fixtures.
 */
import fs from "node:fs";
import path from "node:path";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";

export {
  createCliRuntimeCapture,
  expectGeneratedTokenPersistedToGatewayAuth,
  type CliMockOutputRuntime,
  type CliRuntimeCapture,
} from "openclaw/plugin-sdk/test-fixtures";
export {
  createTempHomeEnv,
  withEnv,
  withEnvAsync,
  withFetchPreconnect,
  isLiveTestEnabled,
} from "openclaw/plugin-sdk/test-env";
export type { FetchMock, TempHomeEnv } from "openclaw/plugin-sdk/test-env";
export type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

export function useAutoCleanupTempDirTracker(registerCleanup: (cleanup: () => void) => unknown) {
  const dirs = new Set<string>();
  registerCleanup(() => {
    for (const dir of dirs) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
    dirs.clear();
  });
  return {
    make(prefix: string): string {
      const dir = fs.mkdtempSync(path.join(resolvePreferredOpenClawTmpDir(), prefix));
      dirs.add(dir);
      return dir;
    },
  };
}
