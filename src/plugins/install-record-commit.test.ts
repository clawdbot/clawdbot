// Plugin install record commit tests cover install record persistence.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  hasRetainedManagedNpmInstallMarker,
  markRetainedManagedNpmInstall,
} from "./managed-npm-retention.js";

const mocks = vi.hoisted(() => ({
  loadInstalledPluginIndexInstallRecords: vi.fn(),
  replaceConfigFile: vi.fn(),
  transformConfigFileWithRetry: vi.fn(),
  writePersistedInstalledPluginIndexInstallRecords: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  replaceConfigFile: mocks.replaceConfigFile,
  resolveConfigWriteAfterWrite: (value?: unknown) => value ?? { mode: "auto" },
  transformConfigFileWithRetry: mocks.transformConfigFileWithRetry,
}));

vi.mock("./installed-plugin-index-records.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./installed-plugin-index-records.js")>();
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
  commitPluginInstallRecordsWithConfig,
  stripPendingPluginInstallRecords,
  transformConfigWithPendingPluginInstalls,
  unchangedPendingPluginInstallRecordIds,
} from "./install-record-commit.js";

describe("commitConfigWithPendingPluginInstalls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue({});
    mocks.replaceConfigFile.mockImplementation(async (params: { nextConfig: OpenClawConfig }) => ({
      path: "/tmp/openclaw.json",
      previousHash: null,
      snapshot: {} as never,
      nextConfig: params.nextConfig,
      persistedHash: "test-config-hash",
      afterWrite: { mode: "auto" },
      followUp: { mode: "auto", requiresRestart: false },
    }));
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
        afterWrite: { mode: "restart", reason: "plugin source changed" },
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
      persistedHash: "test-config-hash",
    });
  });

  it("migrates source records below the canonical index and explicit pending records", async () => {
    const sourceConfig: OpenClawConfig = {
      plugins: {
        installs: {
          stale: { source: "npm", spec: "stale@1.0.0" },
          missing: { source: "npm", spec: "missing@1.0.0" },
          codex: { source: "npm", spec: "codex@1.0.0" },
        },
      },
    };
    const existingRecords: Record<string, PluginInstallRecord> = {
      stale: { source: "npm", spec: "stale@2.0.0" },
      codex: { source: "npm", spec: "codex@2.0.0" },
    };
    const nextConfig: OpenClawConfig = {
      plugins: {
        installs: {
          ...sourceConfig.plugins?.installs,
          codex: { source: "npm", spec: "codex@3.0.0" },
          concurrent: { source: "npm", spec: "concurrent@1.0.0" },
        },
      },
    };
    const commit = vi.fn(async () => undefined);
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(existingRecords);

    const result = await commitConfigWriteWithPendingPluginInstalls({
      nextConfig,
      sourceConfig,
      commit,
    });

    expect(mocks.writePersistedInstalledPluginIndexInstallRecords).toHaveBeenCalledWith({
      stale: existingRecords.stale,
      missing: sourceConfig.plugins?.installs?.missing,
      codex: nextConfig.plugins?.installs?.codex,
      concurrent: nextConfig.plugins?.installs?.concurrent,
    });
    expect(commit).toHaveBeenCalledWith(
      {},
      {
        afterWrite: { mode: "restart", reason: "plugin source changed" },
        unsetPaths: [["plugins", "installs"]],
      },
    );
    expect(result.installRecords).toStrictEqual({
      stale: existingRecords.stale,
      missing: sourceConfig.plugins?.installs?.missing,
      codex: nextConfig.plugins?.installs?.codex,
      concurrent: nextConfig.plugins?.installs?.concurrent,
    });
  });

  it("preserves source records omitted by a transform callback", async () => {
    const sourceConfig: OpenClawConfig = {
      plugins: {
        installs: {
          other: { source: "npm", spec: "other@1.0.0" },
        },
      },
    };
    const codexRecord: PluginInstallRecord = { source: "npm", spec: "codex@2.0.0" };
    const snapshot = { sourceConfig };
    mocks.transformConfigFileWithRetry.mockImplementationOnce(async (params: unknown) => {
      const transformParams = params as {
        transform: (
          config: OpenClawConfig,
          context: { snapshot: typeof snapshot },
        ) => { nextConfig: OpenClawConfig };
        commit: (input: unknown) => Promise<unknown>;
      };
      const transformed = transformParams.transform(sourceConfig, { snapshot });
      await transformParams.commit({ nextConfig: transformed.nextConfig, snapshot });
      return {};
    });

    await transformConfigWithPendingPluginInstalls({
      transform: () => ({
        nextConfig: { plugins: { installs: { codex: codexRecord } } },
      }),
    });

    expect(mocks.writePersistedInstalledPluginIndexInstallRecords).toHaveBeenCalledWith({
      other: sourceConfig.plugins?.installs?.other,
      codex: codexRecord,
    });
  });

  it("strips only selected pending plugin install records", () => {
    const config: OpenClawConfig = {
      plugins: {
        installs: {
          legacy: { source: "npm", spec: "legacy@1.0.0" },
          fresh: { source: "npm", spec: "fresh@1.0.0" },
        },
      },
    };

    expect(stripPendingPluginInstallRecords(config, ["legacy"])).toEqual({
      plugins: {
        installs: {
          fresh: { source: "npm", spec: "fresh@1.0.0" },
        },
      },
    });
  });

  it("selects only unchanged pending plugin install records for migration stripping", () => {
    const baseConfig: OpenClawConfig = {
      plugins: {
        installs: {
          legacy: { source: "npm", spec: "legacy@1.0.0" },
          repaired: { source: "npm", spec: "repaired@1.0.0" },
        },
      },
    };
    const nextConfig: OpenClawConfig = {
      plugins: {
        installs: {
          legacy: { source: "npm", spec: "legacy@1.0.0" },
          repaired: { source: "npm", spec: "repaired@2.0.0" },
          fresh: { source: "npm", spec: "fresh@1.0.0" },
        },
      },
    };

    expect(unchangedPendingPluginInstallRecordIds(nextConfig, baseConfig)).toEqual(["legacy"]);
  });

  it("does not add restart intent when pending records match the plugin index", async () => {
    const existingRecords: Record<string, PluginInstallRecord> = {
      demo: {
        source: "npm",
        spec: "demo@1.0.0",
      },
    };
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(existingRecords);

    await commitConfigWithPendingPluginInstalls({
      nextConfig: {
        plugins: {
          installs: existingRecords,
        },
      },
      baseHash: "config-1",
    });

    expect(mocks.replaceConfigFile).toHaveBeenCalledWith({
      nextConfig: {},
      baseHash: "config-1",
      writeOptions: {
        unsetPaths: [["plugins", "installs"]],
      },
    });
  });

  it("marks replaced managed npm generations when install records are committed", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-record-commit-"));
    const previousInstallPath = path.join(
      stateDir,
      "npm",
      "projects",
      "codex-v1",
      "node_modules",
      "@openclaw",
      "codex",
    );
    const nextInstallPath = path.join(
      stateDir,
      "npm",
      "projects",
      "codex-v2",
      "node_modules",
      "@openclaw",
      "codex",
    );
    fs.mkdirSync(previousInstallPath, { recursive: true });
    fs.mkdirSync(nextInstallPath, { recursive: true });

    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        await commitPluginInstallRecordsWithConfig({
          previousInstallRecords: {
            codex: {
              source: "npm",
              spec: "@openclaw/codex@1.0.0",
              installPath: previousInstallPath,
            },
          },
          nextInstallRecords: {
            codex: {
              source: "npm",
              spec: "@openclaw/codex@2.0.0",
              installPath: nextInstallPath,
            },
          },
          nextConfig: {},
        });
      });

      expect(hasRetainedManagedNpmInstallMarker(previousInstallPath)).toBe(true);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("does not mark arbitrary npm paths outside the managed npm root", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-record-commit-"));
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-record-outside-"));
    const previousInstallPath = path.join(
      outsideRoot,
      "npm",
      "projects",
      "codex-v1",
      "node_modules",
      "@openclaw",
      "codex",
    );
    const nextInstallPath = path.join(
      stateDir,
      "npm",
      "projects",
      "codex-v2",
      "node_modules",
      "@openclaw",
      "codex",
    );
    fs.mkdirSync(previousInstallPath, { recursive: true });
    fs.mkdirSync(nextInstallPath, { recursive: true });

    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        await commitPluginInstallRecordsWithConfig({
          previousInstallRecords: {
            codex: {
              source: "npm",
              spec: "@openclaw/codex@1.0.0",
              installPath: previousInstallPath,
            },
          },
          nextInstallRecords: {
            codex: {
              source: "npm",
              spec: "@openclaw/codex@2.0.0",
              installPath: nextInstallPath,
            },
          },
          nextConfig: {},
        });
      });

      expect(hasRetainedManagedNpmInstallMarker(previousInstallPath)).toBe(false);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
      fs.rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it("marks replaced npm generations across install record id migrations", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-record-commit-"));
    const previousInstallPath = path.join(
      stateDir,
      "npm",
      "projects",
      "voice-call-v1",
      "node_modules",
      "@openclaw",
      "voice-call",
    );
    const nextInstallPath = path.join(
      stateDir,
      "npm",
      "projects",
      "voice-call-v2",
      "node_modules",
      "@openclaw",
      "voice-call",
    );
    fs.mkdirSync(previousInstallPath, { recursive: true });
    fs.mkdirSync(nextInstallPath, { recursive: true });

    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        await commitPluginInstallRecordsWithConfig({
          previousInstallRecords: {
            "voice-call": {
              source: "npm",
              spec: "@openclaw/voice-call@1.0.0",
              installPath: previousInstallPath,
            },
          },
          nextInstallRecords: {
            "@openclaw/voice-call": {
              source: "npm",
              spec: "@openclaw/voice-call@2.0.0",
              installPath: nextInstallPath,
            },
          },
          nextConfig: {},
        });
      });

      expect(hasRetainedManagedNpmInstallMarker(previousInstallPath)).toBe(true);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("removes newly retained npm markers when the config commit rolls back", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-record-commit-"));
    const previousInstallPath = path.join(
      stateDir,
      "npm",
      "projects",
      "codex-v1",
      "node_modules",
      "@openclaw",
      "codex",
    );
    const nextInstallPath = path.join(
      stateDir,
      "npm",
      "projects",
      "codex-v2",
      "node_modules",
      "@openclaw",
      "codex",
    );
    fs.mkdirSync(previousInstallPath, { recursive: true });
    fs.mkdirSync(nextInstallPath, { recursive: true });
    mocks.replaceConfigFile.mockRejectedValueOnce(new Error("config changed"));

    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        await expect(
          commitPluginInstallRecordsWithConfig({
            previousInstallRecords: {
              codex: {
                source: "npm",
                spec: "@openclaw/codex@1.0.0",
                installPath: previousInstallPath,
              },
            },
            nextInstallRecords: {
              codex: {
                source: "npm",
                spec: "@openclaw/codex@2.0.0",
                installPath: nextInstallPath,
              },
            },
            nextConfig: {},
          }),
        ).rejects.toThrow("config changed");
      });

      expect(hasRetainedManagedNpmInstallMarker(previousInstallPath)).toBe(false);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("removes earlier retained markers when a later marker creation fails", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-record-commit-"));
    const firstPreviousInstallPath = path.join(
      stateDir,
      "npm",
      "projects",
      "codex-v1",
      "node_modules",
      "@openclaw",
      "codex",
    );
    const firstNextInstallPath = path.join(
      stateDir,
      "npm",
      "projects",
      "codex-v2",
      "node_modules",
      "@openclaw",
      "codex",
    );
    const secondPreviousInstallPath = path.join(
      stateDir,
      "npm",
      "projects",
      "voice-call-v1",
      "node_modules",
      "@openclaw",
      "voice-call",
    );
    const secondNextInstallPath = path.join(
      stateDir,
      "npm",
      "projects",
      "voice-call-v2",
      "node_modules",
      "@openclaw",
      "voice-call",
    );
    fs.mkdirSync(firstPreviousInstallPath, { recursive: true });
    fs.mkdirSync(firstNextInstallPath, { recursive: true });
    fs.mkdirSync(secondPreviousInstallPath, { recursive: true });
    fs.mkdirSync(secondNextInstallPath, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "npm", "projects", "voice-call-v1", ".openclaw-retained-npm-installs"),
      "not a directory",
      "utf8",
    );

    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        await expect(
          commitPluginInstallRecordsWithConfig({
            previousInstallRecords: {
              codex: {
                source: "npm",
                spec: "@openclaw/codex@1.0.0",
                installPath: firstPreviousInstallPath,
              },
              "voice-call": {
                source: "npm",
                spec: "@openclaw/voice-call@1.0.0",
                installPath: secondPreviousInstallPath,
              },
            },
            nextInstallRecords: {
              codex: {
                source: "npm",
                spec: "@openclaw/codex@2.0.0",
                installPath: firstNextInstallPath,
              },
              "voice-call": {
                source: "npm",
                spec: "@openclaw/voice-call@2.0.0",
                installPath: secondNextInstallPath,
              },
            },
            nextConfig: {},
          }),
        ).rejects.toThrow();
      });

      expect(hasRetainedManagedNpmInstallMarker(firstPreviousInstallPath)).toBe(false);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("clears retained npm markers for active committed install records", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-record-commit-"));
    const installPath = path.join(
      stateDir,
      "npm",
      "projects",
      "codex-v2",
      "node_modules",
      "@openclaw",
      "codex",
    );
    fs.mkdirSync(installPath, { recursive: true });
    await markRetainedManagedNpmInstall({
      packageDir: installPath,
      pluginId: "codex",
      retainedAt: "2026-04-25T00:00:00.000Z",
      reason: "test-retained-generation",
    });

    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        await commitPluginInstallRecordsWithConfig({
          previousInstallRecords: {},
          nextInstallRecords: {
            codex: {
              source: "npm",
              spec: "@openclaw/codex@2.0.0",
              installPath,
            },
          },
          nextConfig: {},
        });
      });

      expect(hasRetainedManagedNpmInstallMarker(installPath)).toBe(false);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("restores cleared active npm markers when the config commit rolls back", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-record-commit-"));
    const installPath = path.join(
      stateDir,
      "npm",
      "projects",
      "codex-v2",
      "node_modules",
      "@openclaw",
      "codex",
    );
    fs.mkdirSync(installPath, { recursive: true });
    await markRetainedManagedNpmInstall({
      packageDir: installPath,
      pluginId: "codex",
      retainedAt: "2026-04-25T00:00:00.000Z",
      reason: "test-retained-generation",
    });
    mocks.replaceConfigFile.mockRejectedValueOnce(new Error("config changed"));

    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        await expect(
          commitPluginInstallRecordsWithConfig({
            previousInstallRecords: {},
            nextInstallRecords: {
              codex: {
                source: "npm",
                spec: "@openclaw/codex@2.0.0",
                installPath,
              },
            },
            nextConfig: {},
          }),
        ).rejects.toThrow("config changed");
      });

      expect(hasRetainedManagedNpmInstallMarker(installPath)).toBe(true);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
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
      persistedHash: "test-config-hash",
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
      persistedHash: null,
    });
  });
});
