/** Tests bundle plugin settings contribution and project settings policy behavior. */
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";

const pluginMetadataSnapshotMocks = vi.hoisted(() => ({
  getCurrentPluginMetadataSnapshot: vi.fn(),
  isPluginMetadataSnapshotCompatible: vi.fn(),
  loadPluginMetadataSnapshot: vi.fn(),
}));

const bundleTestDeps = await vi.hoisted(async () => {
  const fsSync = await import("node:fs");
  const pathModule = await import("node:path");
  const loadBundleRegistry = (params: { workspaceDir?: string }) => {
    const rootDir = pathModule.join(
      params.workspaceDir ?? "",
      ".openclaw",
      "extensions",
      "claude-bundle",
    );
    if (!fsSync.existsSync(pathModule.join(rootDir, ".claude-plugin", "plugin.json"))) {
      return { plugins: [], diagnostics: [] };
    }
    const resolvedRootDir = fsSync.realpathSync(rootDir);
    return {
      diagnostics: [],
      plugins: [
        {
          id: "claude-bundle",
          origin: "workspace",
          format: "bundle",
          bundleFormat: "claude",
          settingsFiles: ["settings.json"],
          rootDir: resolvedRootDir,
        },
      ],
    };
  };
  const loadEmbeddedAgentMcpConfig = (params: {
    workspaceDir: string;
    cfg?: { mcp?: { servers?: Record<string, unknown> } };
  }) => {
    const pluginRoot = pathModule.join(
      params.workspaceDir,
      ".openclaw",
      "extensions",
      "claude-bundle",
    );
    const mcpPath = pathModule.join(pluginRoot, ".mcp.json");
    let bundleServers: Record<string, unknown> = {};
    if (fsSync.existsSync(mcpPath)) {
      const raw = JSON.parse(fsSync.readFileSync(mcpPath, "utf-8")) as {
        mcpServers?: Record<string, { args?: string[]; command?: string }>;
      };
      const resolvedRoot = fsSync.realpathSync(pluginRoot);
      bundleServers = Object.fromEntries(
        Object.entries(raw.mcpServers ?? {}).map(([id, server]) => [
          id,
          {
            ...server,
            args: server.args?.map((arg) =>
              arg.startsWith("./") ? pathModule.join(resolvedRoot, arg) : arg,
            ),
            cwd: resolvedRoot,
          },
        ]),
      );
    }
    return {
      diagnostics: [],
      mcpServers: {
        ...bundleServers,
        ...params.cfg?.mcp?.servers,
      },
    };
  };
  return { fsSync, loadBundleRegistry, loadEmbeddedAgentMcpConfig };
});

vi.mock("../plugins/manifest-registry-installed.js", () => ({
  loadPluginManifestRegistryForInstalledIndex: bundleTestDeps.loadBundleRegistry,
}));

vi.mock("../plugins/plugin-registry.js", () => ({
  loadPluginManifestRegistryForPluginRegistry: bundleTestDeps.loadBundleRegistry,
  loadPluginRegistrySnapshot: () => ({ plugins: [] }),
}));

vi.mock("../plugins/current-plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/current-plugin-metadata-snapshot.js")>()),
  getCurrentPluginMetadataSnapshot: pluginMetadataSnapshotMocks.getCurrentPluginMetadataSnapshot,
}));

vi.mock("../plugins/plugin-metadata-snapshot.js", () => {
  pluginMetadataSnapshotMocks.isPluginMetadataSnapshotCompatible.mockImplementation(() => false);
  pluginMetadataSnapshotMocks.loadPluginMetadataSnapshot.mockImplementation(
    (params: { workspaceDir?: string }) => ({
      manifestRegistry: bundleTestDeps.loadBundleRegistry(params),
      normalizePluginId: (id: string) => id.trim(),
    }),
  );
  return {
    isPluginMetadataSnapshotCompatible:
      pluginMetadataSnapshotMocks.isPluginMetadataSnapshotCompatible,
    loadPluginMetadataSnapshot: pluginMetadataSnapshotMocks.loadPluginMetadataSnapshot,
  };
});

vi.mock("./embedded-agent-mcp.js", () => ({
  loadEmbeddedAgentMcpConfig: bundleTestDeps.loadEmbeddedAgentMcpConfig,
}));

const { loadEnabledBundleAgentSettingsSnapshot } =
  await import("./agent-project-settings-snapshot.js");

const tempDirs = createTrackedTempDirs();

afterEach(async () => {
  await tempDirs.cleanup();
  pluginMetadataSnapshotMocks.getCurrentPluginMetadataSnapshot.mockReset();
  pluginMetadataSnapshotMocks.getCurrentPluginMetadataSnapshot.mockReturnValue(undefined);
  pluginMetadataSnapshotMocks.isPluginMetadataSnapshotCompatible.mockClear();
  pluginMetadataSnapshotMocks.loadPluginMetadataSnapshot.mockClear();
});

async function createWorkspaceBundle(params: {
  workspaceDir: string;
  pluginId?: string;
}): Promise<string> {
  const pluginId = params.pluginId ?? "claude-bundle";
  const pluginRoot = path.join(params.workspaceDir, ".openclaw", "extensions", pluginId);
  await fs.mkdir(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
  await fs.writeFile(
    path.join(pluginRoot, ".claude-plugin", "plugin.json"),
    JSON.stringify({
      name: pluginId,
    }),
    "utf-8",
  );
  return pluginRoot;
}

describe("loadEnabledBundleAgentSettingsSnapshot", () => {
  it("reuses a compatible plugin metadata snapshot without loading a fresh one", async () => {
    const workspaceDir = await tempDirs.make("openclaw-workspace-");
    const pluginRoot = await createWorkspaceBundle({ workspaceDir });
    const resolvedPluginRoot = await fs.realpath(pluginRoot);
    await fs.writeFile(
      path.join(pluginRoot, "settings.json"),
      JSON.stringify({ hideThinkingBlock: true }),
      "utf-8",
    );

    pluginMetadataSnapshotMocks.isPluginMetadataSnapshotCompatible.mockReturnValueOnce(true);
    pluginMetadataSnapshotMocks.loadPluginMetadataSnapshot.mockClear();

    const snapshot = loadEnabledBundleAgentSettingsSnapshot({
      cwd: workspaceDir,
      cfg: {
        plugins: {
          entries: {
            "claude-bundle": { enabled: true },
          },
        },
      },
      pluginMetadataSnapshot: {
        manifestRegistry: {
          diagnostics: [],
          plugins: [
            {
              id: "claude-bundle",
              origin: "workspace",
              format: "bundle",
              bundleFormat: "claude",
              settingsFiles: ["settings.json"],
              rootDir: resolvedPluginRoot,
            },
          ],
        },
        normalizePluginId: (id: string) => id.trim(),
      } as unknown as Parameters<
        typeof loadEnabledBundleAgentSettingsSnapshot
      >[0]["pluginMetadataSnapshot"],
    });

    expect(snapshot.hideThinkingBlock).toBe(true);
    expect(pluginMetadataSnapshotMocks.loadPluginMetadataSnapshot).not.toHaveBeenCalled();
  });

  it("treats a supplied lifecycle snapshot as authoritative across workspaces", async () => {
    const workspaceDir = await tempDirs.make("openclaw-workspace-");
    const pluginRoot = await createWorkspaceBundle({ workspaceDir });
    await fs.writeFile(
      path.join(pluginRoot, "settings.json"),
      JSON.stringify({ hideThinkingBlock: true }),
      "utf-8",
    );

    pluginMetadataSnapshotMocks.getCurrentPluginMetadataSnapshot.mockClear();
    pluginMetadataSnapshotMocks.loadPluginMetadataSnapshot.mockClear();

    const snapshot = loadEnabledBundleAgentSettingsSnapshot({
      cwd: workspaceDir,
      cfg: {
        plugins: {
          entries: {
            "claude-bundle": { enabled: true },
          },
        },
      },
      pluginMetadataSnapshot: {
        workspaceDir: "/tmp/gateway-plugin-workspace",
        manifestRegistry: {
          diagnostics: [],
          plugins: [
            {
              id: "claude-bundle",
              format: "bundle",
              origin: "global",
              enabledByDefault: true,
              settingsFiles: ["settings.json"],
              rootDir: pluginRoot,
            },
          ],
        },
        normalizePluginId: (id: string) => id.trim(),
      } as unknown as Parameters<
        typeof loadEnabledBundleAgentSettingsSnapshot
      >[0]["pluginMetadataSnapshot"],
    });

    expect(snapshot.hideThinkingBlock).toBe(true);
    expect(pluginMetadataSnapshotMocks.getCurrentPluginMetadataSnapshot).not.toHaveBeenCalled();
    expect(pluginMetadataSnapshotMocks.loadPluginMetadataSnapshot).not.toHaveBeenCalled();
  });

  it("loads sanitized settings and MCP defaults from enabled bundle plugins", async () => {
    const workspaceDir = await tempDirs.make("openclaw-workspace-");
    const pluginRoot = await createWorkspaceBundle({ workspaceDir });
    const resolvedPluginRoot = await fs.realpath(pluginRoot);
    await fs.mkdir(path.join(pluginRoot, "servers"), { recursive: true });
    const resolvedServerPath = await fs.realpath(path.join(pluginRoot, "servers"));
    await fs.writeFile(
      path.join(pluginRoot, "settings.json"),
      JSON.stringify({
        hideThinkingBlock: true,
        shellPath: "/tmp/blocked-shell",
        compaction: { keepRecentTokens: 64_000 },
      }),
      "utf-8",
    );
    await fs.writeFile(
      path.join(pluginRoot, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          bundleProbe: {
            command: "node",
            args: ["./servers/probe.mjs"],
          },
          sharedServer: {
            command: "node",
            args: ["./servers/bundle.mjs"],
          },
        },
      }),
      "utf-8",
    );

    const snapshot = loadEnabledBundleAgentSettingsSnapshot({
      cwd: workspaceDir,
      cfg: {
        plugins: {
          entries: {
            "claude-bundle": { enabled: true },
          },
        },
      },
    });

    expect(snapshot.hideThinkingBlock).toBe(true);
    expect(snapshot.shellPath).toBeUndefined();
    expect(snapshot.compaction?.keepRecentTokens).toBe(64_000);
    expect((snapshot as Record<string, unknown>).mcpServers).toEqual({
      bundleProbe: {
        command: "node",
        args: [path.join(resolvedServerPath, "probe.mjs")],
        cwd: resolvedPluginRoot,
      },
      sharedServer: {
        command: "node",
        args: [path.join(resolvedServerPath, "bundle.mjs")],
        cwd: resolvedPluginRoot,
      },
    });

    const overridden = loadEnabledBundleAgentSettingsSnapshot({
      cwd: workspaceDir,
      cfg: {
        mcp: {
          servers: {
            sharedServer: {
              url: "https://example.com/mcp",
            },
          },
        },
        plugins: {
          entries: {
            "claude-bundle": { enabled: true },
          },
        },
      },
    });

    expect((overridden as Record<string, unknown>).mcpServers).toEqual({
      bundleProbe: {
        command: "node",
        args: [path.join(resolvedServerPath, "probe.mjs")],
        cwd: resolvedPluginRoot,
      },
      sharedServer: {
        url: "https://example.com/mcp",
      },
    });
  });

  it("ignores disabled bundle plugins", async () => {
    const workspaceDir = await tempDirs.make("openclaw-workspace-");
    const pluginRoot = await createWorkspaceBundle({ workspaceDir });
    await fs.writeFile(
      path.join(pluginRoot, "settings.json"),
      JSON.stringify({ hideThinkingBlock: true }),
      "utf-8",
    );

    const snapshot = loadEnabledBundleAgentSettingsSnapshot({
      cwd: workspaceDir,
      cfg: {
        plugins: {
          entries: {
            "claude-bundle": { enabled: false },
          },
        },
      },
    });

    expect(snapshot).toStrictEqual({});
  });
});
