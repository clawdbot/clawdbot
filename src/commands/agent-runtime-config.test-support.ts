import { vi } from "vitest";
import { __testing as acpManagerTesting } from "../acp/control-plane/manager.js";
import { loadModelCatalog } from "../agents/model-catalog.js";
import * as modelSelectionModule from "../agents/model-selection.js";
import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import type { OpenClawConfig } from "../config/config.js";
import * as configModule from "../config/config.js";
import { clearSessionStoreCacheForTest } from "../config/sessions.js";
import { resetAgentEventsForTest, resetAgentRunContextForTest } from "../infra/agent-events.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  createDefaultAgentCommandResult,
  mockAgentCommandConfig,
  withAgentCommandTempHome,
} from "./agent-command.test-support.js";

vi.mock("../agents/auth-profiles.js", () => {
  return {
    ensureAuthProfileStore: vi.fn(() => ({ version: 1, profiles: {} })),
  };
});

vi.mock("../agents/auth-profiles/store.js", () => {
  const createEmptyStore = () => ({ version: 1, profiles: {} });
  return {
    clearRuntimeAuthProfileStoreSnapshots: vi.fn(),
    ensureAuthProfileStore: vi.fn(createEmptyStore),
    ensureAuthProfileStoreForLocalUpdate: vi.fn(createEmptyStore),
    hasAnyAuthProfileStoreSource: vi.fn(() => false),
    loadAuthProfileStore: vi.fn(createEmptyStore),
    loadAuthProfileStoreForRuntime: vi.fn(createEmptyStore),
    loadAuthProfileStoreForSecretsRuntime: vi.fn(createEmptyStore),
    replaceRuntimeAuthProfileStoreSnapshots: vi.fn(),
    saveAuthProfileStore: vi.fn(),
    updateAuthProfileStoreWithLock: vi.fn(async () => createEmptyStore()),
  };
});

export const runtime: RuntimeEnv = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(() => {
    throw new Error("exit");
  }),
};

export async function withSharedAgentCommandTempHome<T>(
  prefix: string,
  fn: (home: string) => Promise<T>,
): Promise<T> {
  return withAgentCommandTempHome(prefix, fn);
}

export function mockSharedAgentCommandConfig(
  configSpy: Parameters<typeof mockAgentCommandConfig>[0],
  home: string,
  storePath: string,
  agentOverrides?: Parameters<typeof mockAgentCommandConfig>[3],
) {
  return mockAgentCommandConfig(configSpy, home, storePath, agentOverrides);
}

export function resetSharedAgentCommandRuntimeState(
  readConfigFileSnapshotForWriteSpy: typeof configModule.readConfigFileSnapshotForWrite,
) {
  vi.clearAllMocks();
  clearSessionStoreCacheForTest();
  resetAgentEventsForTest();
  resetAgentRunContextForTest();
  resetPluginRuntimeStateForTest();
  acpManagerTesting.resetAcpSessionManagerForTests();
  configModule.clearRuntimeConfigSnapshot();
  vi.mocked(runEmbeddedPiAgent).mockResolvedValue(createDefaultAgentCommandResult());
  vi.mocked(loadModelCatalog).mockResolvedValue([]);
  vi.mocked(modelSelectionModule.isCliProvider).mockImplementation(() => false);
  vi.mocked(readConfigFileSnapshotForWriteSpy).mockResolvedValue({
    snapshot: { valid: false, resolved: {} as OpenClawConfig },
    writeOptions: {},
  } as Awaited<ReturnType<typeof configModule.readConfigFileSnapshotForWrite>>);
}
