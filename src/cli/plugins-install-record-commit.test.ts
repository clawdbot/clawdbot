import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";

const mocks = vi.hoisted(() => ({
  loadInstalledPluginIndexInstallRecords: vi.fn(),
  replaceConfigFile: vi.fn(),
  writePersistedInstalledPluginIndexInstallRecords: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  replaceConfigFile: mocks.replaceConfigFile,
}));

vi.mock("../plugins/installed-plugin-index-records.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../plugins/installed-plugin-index-records.js")>();
  return {
    ...actual,
    loadInstalledPluginIndexInstallRecords: mocks.loadInstalledPluginIndexInstallRecords,
    writePersistedInstalledPluginIndexInstallRecords:
      mocks.writePersistedInstalledPluginIndexInstallRecords,
  };
});

import {
  commitConfigWithPendingPluginInstalls,
  commitConfigWriteWithPendingPluginInstalls,
} from "./plugins-install-record-commit.js";

describe("commitConfigWithPendingPluginInstalls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue({});
    mocks.replaceConfigFile.mockResolvedValue(undefined);
    mocks.writePersistedInstalledPluginIndexInstallRecords.mockResolvedValue(undefined);
  });

  it("moves pending plugin install records into the plugin index before writing stripped config", async () => {
    const existingRecords: Record<string, PluginInstallRecord> = {
      existing: {
        source: "npm",
        spec: "existing@1.0.0",
      },
    };
    const pendingRecords: Record<string, PluginInstallRecord> = {
      demo: {
        source: "npm",
        spec: "demo@1.0.0",
      },
    };
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(existingRecords);
    const nextConfig: OpenClawConfig = {
      plugins: {
        entries: {
          demo: { enabled: true },
        },
        installs: pendingRecords,
      },
    };

    const result = await commitConfigWithPendingPluginInstalls({
      nextConfig,
      baseHash: "config-1",
    });

    expect(mocks.writePersistedInstalledPluginIndexInstallRecords).toHaveBeenCalledWith({
      ...existingRecords,
      ...pendingRecords,
    });
    expect(mocks.replaceConfigFile).toHaveBeenCalledWith({
      nextConfig: {
        plugins: {
          entries: {
            demo: { enabled: true },
          },
        },
      },
      baseHash: "config-1",
      writeOptions: {
        unsetPaths: [["plugins", "installs"]],
      },
    });
    expect(result).toEqual({
      config: {
        plugins: {
          entries: {
            demo: { enabled: true },
          },
        },
      },
      installRecords: {
        ...existingRecords,
        ...pendingRecords,
      },
      movedInstallRecords: true,
    });
  });

  it("rolls back plugin index writes when the config write fails", async () => {
    const existingRecords: Record<string, PluginInstallRecord> = {
      existing: {
        source: "npm",
        spec: "existing@1.0.0",
      },
    };
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(existingRecords);
    mocks.replaceConfigFile.mockRejectedValue(new Error("config changed"));

    await expect(
      commitConfigWithPendingPluginInstalls({
        nextConfig: {
          plugins: {
            installs: {
              demo: {
                source: "npm",
                spec: "demo@1.0.0",
              },
            },
          },
        },
      }),
    ).rejects.toThrow("config changed");

    expect(mocks.writePersistedInstalledPluginIndexInstallRecords).toHaveBeenNthCalledWith(1, {
      existing: {
        source: "npm",
        spec: "existing@1.0.0",
      },
      demo: {
        source: "npm",
        spec: "demo@1.0.0",
      },
    });
    expect(mocks.writePersistedInstalledPluginIndexInstallRecords).toHaveBeenNthCalledWith(
      2,
      existingRecords,
    );
  });

  it("uses a plain config write when no pending plugin install records exist", async () => {
    const nextConfig: OpenClawConfig = {
      gateway: {
        mode: "local",
      },
    };

    const result = await commitConfigWithPendingPluginInstalls({ nextConfig });

    expect(mocks.loadInstalledPluginIndexInstallRecords).not.toHaveBeenCalled();
    expect(mocks.writePersistedInstalledPluginIndexInstallRecords).not.toHaveBeenCalled();
    expect(mocks.replaceConfigFile).toHaveBeenCalledWith({
      nextConfig,
    });
    expect(result).toEqual({
      config: nextConfig,
      installRecords: {},
      movedInstallRecords: false,
    });
  });

  it("supports non-replace config writers without adding an undefined write options argument", async () => {
    const writeConfigFile = vi.fn(async () => undefined);
    const nextConfig: OpenClawConfig = {
      gateway: {
        mode: "local",
      },
    };

    const result = await commitConfigWriteWithPendingPluginInstalls({
      nextConfig,
      commit: writeConfigFile,
    });

    expect(writeConfigFile).toHaveBeenCalledWith(nextConfig);
    expect(result).toEqual({
      config: nextConfig,
      installRecords: {},
      movedInstallRecords: false,
    });
  });
});
