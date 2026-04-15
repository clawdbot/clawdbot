import type { Mock } from "vitest";
import { vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { mergeMockedModule } from "../test-utils/vitest-module-mocks.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

type ReplaceConfigFileResult = Awaited<
  ReturnType<(typeof import("../config/config.js"))["replaceConfigFile"]>
>;

export const readConfigFileSnapshotMock: Mock<(...args: unknown[]) => Promise<unknown>> = vi.fn();
export const writeConfigFileMock: Mock<(...args: unknown[]) => Promise<unknown>> = vi
  .fn()
  .mockResolvedValue(undefined);
export const replaceConfigFileMock: Mock<(...args: unknown[]) => Promise<unknown>> = vi.fn(
  async (params: { nextConfig: OpenClawConfig }): Promise<ReplaceConfigFileResult> => {
    await writeConfigFileMock(params.nextConfig);
    return {
      path: "/tmp/openclaw.json",
      previousHash: null,
      snapshot: {} as never,
      nextConfig: params.nextConfig,
    };
  },
) as Mock<(...args: unknown[]) => Promise<unknown>>;

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return await mergeMockedModule(actual, () => ({
    readConfigFileSnapshot: (...args: Parameters<typeof actual.readConfigFileSnapshot>) =>
      readConfigFileSnapshotMock(...args) as ReturnType<typeof actual.readConfigFileSnapshot>,
    writeConfigFile: (...args: Parameters<typeof actual.writeConfigFile>) =>
      writeConfigFileMock(...args) as ReturnType<typeof actual.writeConfigFile>,
    replaceConfigFile: (...args: Parameters<typeof actual.replaceConfigFile>) =>
      replaceConfigFileMock(...args) as ReturnType<typeof actual.replaceConfigFile>,
  }));
});

export const runtime = createTestRuntime();

let agentsCommandModulePromise: Promise<typeof import("./agents.js")> | undefined;
let agentsBindCommandModulePromise: Promise<typeof import("./agents.commands.bind.js")> | undefined;

export async function loadFreshAgentsCommandModuleForTest() {
  agentsCommandModulePromise ??= import("./agents.js");
  return await agentsCommandModulePromise;
}

export async function loadFreshAgentsBindCommandModuleForTest() {
  agentsBindCommandModulePromise ??= import("./agents.commands.bind.js");
  return await agentsBindCommandModulePromise;
}

export function resetAgentsBindTestHarness(): void {
  readConfigFileSnapshotMock.mockClear();
  writeConfigFileMock.mockClear();
  replaceConfigFileMock.mockClear();
  runtime.log.mockClear();
  runtime.error.mockClear();
  runtime.exit.mockClear();
}
