import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";

vi.mock("../infra/boundary-file-read.js", async () => {
  const fs = await import("node:fs");
  return {
    openBoundaryFileSync: ({ absolutePath }: { absolutePath: string }) => ({
      ok: true,
      fd: fs.openSync(absolutePath, "r"),
    }),
  };
});

vi.mock("../plugins/manifest-registry.js", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  return {
    loadPluginManifestRegistry: (params: { workspaceDir?: string }) => {
      const rootDir = path.join(
        params.workspaceDir ?? "",
        ".openclaw",
        "extensions",
        "claude-bundle",
      );
      if (!fs.existsSync(path.join(rootDir, ".claude-plugin", "plugin.json"))) {
        return { plugins: [], diagnostics: [] };
      }
      const resolvedRootDir = fs.realpathSync(rootDir);
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
    },
  };
});

vi.mock("./embedded-pi-mcp.js", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  return {
    loadEmbeddedPiMcpConfig: (params: {
      workspaceDir: string;
      cfg?: { mcp?: { servers?: Record<string, unknown> } };
    }) => {
      const pluginRoot = path.join(params.workspaceDir, ".openclaw", "extensions", "claude-bundle");
      const mcpPath = path.join(pluginRoot, ".mcp.json");
      let bundleServers: Record<string, unknown> = {};
      if (fs.existsSync(mcpPath)) {
        const raw = JSON.parse(fs.readFileSync(mcpPath, "utf-8")) as {
          mcpServers?: Record<string, { args?: string[]; command?: string }>;
        };
        const resolvedRoot = fs.realpathSync(pluginRoot);
        bundleServers = Object.fromEntries(
          Object.entries(raw.mcpServers ?? {}).map(([id, server]) => [
            id,
            {
              ...server,
              args: server.args?.map((arg) =>
                arg.startsWith("./") ? path.join(resolvedRoot, arg) : arg,
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
    },
  };
});

const { loadEnabledBundlePiSettingsSnapshot } = await import("./pi-project-settings-snapshot.js");

const tempDirs = createTrackedTempDirs();

afterEach(async () => {
  await tempDirs.cleanup();
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

describe("loadEnabledBundlePiSettingsSnapshot", () => {
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

    const snapshot = loadEnabledBundlePiSettingsSnapshot({
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

    const overridden = loadEnabledBundlePiSettingsSnapshot({
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

    const snapshot = loadEnabledBundlePiSettingsSnapshot({
      cwd: workspaceDir,
      cfg: {
        plugins: {
          entries: {
            "claude-bundle": { enabled: false },
          },
        },
      },
    });

    expect(snapshot).toEqual({});
  });
});
