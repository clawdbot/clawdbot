import { vi } from "vitest";

// Shared config.js mock for health-snapshot suites that do not exercise drift.
// Match the runtime accessor's null absence contract so these tests omit the
// diagnostic instead of synthesizing an unknown-source warning.
export function installHealthConfigMock(getConfig: () => Record<string, unknown>): void {
  vi.doMock("../config/config.js", () => ({
    getRuntimeConfig: getConfig,
    loadConfig: getConfig,
    getRuntimeConfigSourceSnapshot: () => undefined,
    getRuntimeConfigSnapshotMetadata: () => null,
    hashRuntimeConfigValue: (config: Record<string, unknown>) => JSON.stringify(config),
  }));
}
