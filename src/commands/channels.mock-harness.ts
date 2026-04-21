import { vi } from "vitest";
import type { MockFn } from "../test-utils/vitest-mock-fn.js";

const readConfigFileSnapshotMock = vi.fn() as unknown as MockFn;
const writeConfigFileMock = vi.fn().mockResolvedValue(undefined) as unknown as MockFn;
const replaceConfigFileMock = vi.fn(async (params: { nextConfig: unknown }) => {
  await writeConfigFileMock(params.nextConfig);
}) as unknown as MockFn;

export const configMocks: {
  readConfigFileSnapshot: MockFn;
  writeConfigFile: MockFn;
  replaceConfigFile: MockFn;
} = {
  readConfigFileSnapshot: readConfigFileSnapshotMock,
  writeConfigFile: writeConfigFileMock,
  replaceConfigFile: replaceConfigFileMock,
};

export const offsetMocks: {
  deleteTelegramUpdateOffset: MockFn;
} = {
  deleteTelegramUpdateOffset: vi.fn().mockResolvedValue(undefined) as unknown as MockFn,
};

export const lifecycleMocks: {
  onAccountConfigChanged: MockFn;
} = {
  onAccountConfigChanged: vi.fn().mockResolvedValue(undefined) as unknown as MockFn,
};

export const secretMocks = {
  resolveCommandConfigWithSecrets: vi.fn(async ({ config }: { config: unknown }) => ({
    resolvedConfig: config,
    effectiveConfig: config,
    diagnostics: [],
  })) as unknown as MockFn,
};

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: configMocks.readConfigFileSnapshot,
  writeConfigFile: configMocks.writeConfigFile,
  replaceConfigFile: configMocks.replaceConfigFile,
}));

vi.mock("../cli/command-config-resolution.js", () => ({
  resolveCommandConfigWithSecrets: secretMocks.resolveCommandConfigWithSecrets,
}));

vi.mock("../cli/command-secret-targets.js", () => ({
  getChannelsCommandSecretTargetIds: () => new Set<string>(),
}));
