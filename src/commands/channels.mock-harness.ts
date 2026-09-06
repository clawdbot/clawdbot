// Shared Vitest mock harness for channel command config and secret resolution.
import { vi } from "vitest";
import type { MockFn } from "../test-utils/vitest-mock-fn.js";

const readConfigFileSnapshotMock = vi.fn() as unknown as MockFn;
const readConfigFileSnapshotForWriteMock = vi.fn(async () => {
  const snapshot = await readConfigFileSnapshotMock();
  return {
    snapshot: { ...snapshot, sourceConfig: snapshot.sourceConfig ?? snapshot.config },
    writeOptions: {},
  };
}) as unknown as MockFn;
const writeConfigFileMock = vi.fn().mockResolvedValue(undefined) as unknown as MockFn;
const replaceConfigFileMock = vi.fn(async (params: { sourceConfig: unknown }) => {
  await writeConfigFileMock(params.sourceConfig);
}) as unknown as MockFn;

export const configMocks: {
  readConfigFileSnapshot: MockFn;
  readConfigFileSnapshotForWrite: MockFn;
  writeConfigFile: MockFn;
  replaceConfigFile: MockFn;
} = {
  readConfigFileSnapshot: readConfigFileSnapshotMock,
  readConfigFileSnapshotForWrite: readConfigFileSnapshotForWriteMock,
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
  readConfigFileSnapshotForWrite: configMocks.readConfigFileSnapshotForWrite,
  writeConfigFile: configMocks.writeConfigFile,
  replaceConfigFile: configMocks.replaceConfigFile,
}));

vi.mock("../cli/command-config-resolution.js", () => ({
  resolveCommandConfigWithSecrets: secretMocks.resolveCommandConfigWithSecrets,
}));

vi.mock("../cli/command-secret-targets.js", () => ({
  getChannelsCommandSecretTargetIds: () => new Set<string>(),
}));
