// Agent binding test support centralizes mocked channel plugin registries and lazy imports.
import type { Mock } from "vitest";
import { vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

type ReplaceConfigFileResult = Awaited<
  ReturnType<(typeof import("../config/config.js"))["replaceConfigFile"]>
>;

export const readConfigFileSnapshotMock: Mock<(...args: unknown[]) => Promise<unknown>> = vi.fn();
export const writeConfigFileMock: Mock<(...args: unknown[]) => Promise<unknown>> = vi
  .fn()
  .mockResolvedValue(undefined);
const replaceConfigFileMock: Mock<(...args: unknown[]) => Promise<unknown>> = vi.fn(
  async (params: { sourceConfig: OpenClawConfig }): Promise<ReplaceConfigFileResult> => {
    await writeConfigFileMock(params.sourceConfig);
    return {
      path: "/tmp/openclaw.json",
      previousHash: null,
      snapshot: {} as never,
      nextConfig: params.sourceConfig,
      persistedHash: "test-config-hash",
      afterWrite: { mode: "auto" },
      followUp: { mode: "auto", requiresRestart: false },
    };
  },
) as Mock<(...args: unknown[]) => Promise<unknown>>;

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: (...args: unknown[]) => readConfigFileSnapshotMock(...args),
  writeConfigFile: (...args: unknown[]) => writeConfigFileMock(...args),
  replaceConfigFile: (...args: unknown[]) => replaceConfigFileMock(...args),
}));

vi.mock("./agents.command-shared.js", () => ({
  createQuietRuntime: <T>(runtime: T) => runtime,
}));

vi.mock("./config-validation.js", () => ({
  requireValidConfig: async (_runtime: unknown, opts?: unknown) => {
    const snapshot = (await readConfigFileSnapshotMock(opts)) as
      | { config?: OpenClawConfig; sourceConfig?: OpenClawConfig }
      | undefined;
    return snapshot?.sourceConfig ?? snapshot?.config ?? null;
  },
  requireValidConfigForWrite: async () => {
    const snapshot = (await readConfigFileSnapshotMock()) as {
      sourceConfig?: OpenClawConfig;
      config: OpenClawConfig;
    };
    return {
      snapshot: { ...snapshot, sourceConfig: snapshot.sourceConfig ?? snapshot.config },
      writeOptions: {},
    };
  },
}));

export const runtime = createTestRuntime();

const agentsBindCommandModuleLoader = createLazyImportLoader(
  () => import("./agents.commands.bind.js"),
);

export async function loadFreshAgentsBindCommandModuleForTest() {
  return await agentsBindCommandModuleLoader.load();
}

export function resetAgentsBindTestHarness(): void {
  readConfigFileSnapshotMock.mockClear();
  writeConfigFileMock.mockClear();
  replaceConfigFileMock.mockClear();
  runtime.log.mockClear();
  runtime.error.mockClear();
  runtime.exit.mockClear();
}
