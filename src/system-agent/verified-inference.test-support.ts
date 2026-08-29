import { vi } from "vitest";
import type { PluginOrigin } from "../plugins/types.js";

type TestPluginRecord = {
  pluginId: string;
  origin: PluginOrigin;
  rootDir: string;
  manifestPath: string;
  manifestHash: string;
  source: string;
  packageName: string;
  packageVersion: string;
  installRecordHash?: string;
  packageJson: { path: string; hash: string };
};

export function pluginRecord(
  pluginId: string,
  overrides: Partial<TestPluginRecord> = {},
): TestPluginRecord {
  const rootDir = `/plugins/${pluginId}`;
  return {
    pluginId,
    origin: "global",
    rootDir,
    manifestPath: `${rootDir}/openclaw.plugin.json`,
    manifestHash: `${pluginId}-manifest-v1`,
    source: `${rootDir}/index.js`,
    packageName: `@openclaw/${pluginId}`,
    packageVersion: "1.0.0",
    installRecordHash: `${pluginId}-install-v1`,
    packageJson: { path: `${rootDir}/package.json`, hash: `${pluginId}-package-v1` },
    ...overrides,
  };
}

export function pluginArtifactDeps() {
  return {
    fingerprintPluginRuntimeArtifact: (record: { pluginId: string }) =>
      `${record.pluginId}-runtime-v1`,
  };
}

export function cliRuntimeArtifactDeps(fingerprint = "claude-cli-artifact-v1") {
  return {
    resolveCliRuntimeArtifactFingerprint: vi.fn(async () => fingerprint),
  };
}

export const cliRuntimeArtifactAuth = {
  runtimeArtifactFingerprint: "claude-cli-artifact-v1",
  runtimeArtifactId: "claude-cli",
} as const;

export const codexRuntimeArtifactAuth = {
  runtimeArtifactFingerprint: "codex-runtime-v1",
  runtimeArtifactId: "codex-app-server",
} as const;
