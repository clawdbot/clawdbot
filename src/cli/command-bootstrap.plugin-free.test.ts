// Behavioral bootstrap coverage for plugin-free CLI command preflight.
import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetAutoMigrateLegacyStateDirForTest,
  resetAutoMigrateLegacyStateForTest,
  resetAutoMigrateLegacyTaskStateSidecarsForTest,
} from "../infra/state-migrations.js";
import { clearPluginDoctorContractRegistryCache } from "../plugins/doctor-contract-registry.test-fixtures.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { ensureCliCommandBootstrap } from "./command-bootstrap.js";
import { testApi as configGuardTestApi } from "./program/config-guard.js";

const sourceTransformMocks = vi.hoisted(() => {
  const loader = vi.fn(() => ({}));
  return {
    loader,
    createLoader: vi.fn(() => loader),
  };
});

vi.mock("../plugins/plugin-module-loader-cache.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/plugin-module-loader-cache.js")>();
  return {
    ...actual,
    getCachedPluginModuleLoader: (
      params: Parameters<typeof actual.getCachedPluginModuleLoader>[0],
    ) =>
      actual.getCachedPluginModuleLoader({
        ...params,
        createLoader: sourceTransformMocks.createLoader as never,
      }),
  };
});

describe("plugin-free command bootstrap", () => {
  let testState: OpenClawTestState | undefined;
  let sourceOnlyPluginRoot = "";

  beforeEach(async () => {
    testState = await createOpenClawTestState({
      label: "cli-plugin-free",
      scenario: "minimal",
    });
    sourceOnlyPluginRoot = testState.path("source-only-channel");
    await fs.mkdir(sourceOnlyPluginRoot, { recursive: true });
    await fs.writeFile(
      testState.path("source-only-channel", "openclaw.plugin.json"),
      JSON.stringify({
        id: "source-only-channel",
        configSchema: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
      }),
      "utf8",
    );
    await fs.writeFile(
      testState.path("source-only-channel", "index.ts"),
      "export default { id: 'source-only-channel', register() {} };\n",
      "utf8",
    );
    await testState.writeConfig({
      channels: {
        "source-only-channel": {
          enabled: false,
        },
      },
      plugins: {
        load: {
          paths: [sourceOnlyPluginRoot],
        },
        entries: {
          "source-only-channel": {
            enabled: true,
          },
        },
      },
    });
    configGuardTestApi.resetConfigGuardStateForTests();
    resetAutoMigrateLegacyStateForTest();
    resetAutoMigrateLegacyStateDirForTest();
    resetAutoMigrateLegacyTaskStateSidecarsForTest();
    clearPluginDoctorContractRegistryCache();
    sourceTransformMocks.loader.mockClear();
    sourceTransformMocks.createLoader.mockClear();
  });

  afterEach(async () => {
    clearPluginDoctorContractRegistryCache();
    configGuardTestApi.resetConfigGuardStateForTests();
    resetAutoMigrateLegacyStateForTest();
    resetAutoMigrateLegacyStateDirForTest();
    resetAutoMigrateLegacyTaskStateSidecarsForTest();
    await testState?.cleanup();
    testState = undefined;
  });

  async function writeInvalidSourceChannelConfig() {
    await testState?.writeConfig({
      gateway: {
        port: "invalid",
      },
      channels: {
        "source-only-channel": {
          enabled: false,
        },
      },
      plugins: {
        load: {
          paths: [sourceOnlyPluginRoot],
        },
        entries: {
          "source-only-channel": {
            enabled: true,
          },
        },
      },
    });
  }

  it("does not create a source-transform loader for gateway call", async () => {
    await writeInvalidSourceChannelConfig();
    const runtime = {
      error: vi.fn(),
      exit: vi.fn((code: number) => {
        throw new Error(`unexpected config-guard exit ${code}`);
      }),
    };

    await ensureCliCommandBootstrap({
      runtime: runtime as never,
      commandPath: ["gateway", "call"],
      loadPlugins: false,
    });

    expect(sourceTransformMocks.loader).not.toHaveBeenCalled();
    expect(sourceTransformMocks.createLoader).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("keeps invalid-config snapshots plugin-free for health", async () => {
    await writeInvalidSourceChannelConfig();
    const runtime = {
      error: vi.fn(),
      exit: vi.fn((code: number) => {
        throw new Error(`unexpected config-guard exit ${code}`);
      }),
    };

    await ensureCliCommandBootstrap({
      runtime: runtime as never,
      commandPath: ["health"],
      loadPlugins: false,
    });

    expect(sourceTransformMocks.loader).not.toHaveBeenCalled();
    expect(sourceTransformMocks.createLoader).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("defers opaque channel session migration without loading its runtime", async () => {
    const legacySessionKey = "15551234567@g.us";
    await testState?.writeJson("sessions/sessions.json", {
      [legacySessionKey]: {
        sessionId: "legacy-channel-session",
        updatedAt: 1,
      },
    });
    const runtime = {
      error: vi.fn(),
      exit: vi.fn((code: number) => {
        throw new Error(`unexpected config-guard exit ${code}`);
      }),
    };

    await ensureCliCommandBootstrap({
      runtime: runtime as never,
      commandPath: ["gateway", "call"],
      loadPlugins: false,
    });

    const preservedStore = JSON.parse(
      await fs.readFile(testState!.statePath("sessions", "sessions.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(preservedStore).toHaveProperty(legacySessionKey);
    await expect(
      fs.stat(testState!.statePath("agents", "main", "sessions", "sessions.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(sourceTransformMocks.createLoader).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });
});
