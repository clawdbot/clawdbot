/** Tests live session MCP projections and launch config isolation. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { loadSessionMcpConfig } from "./agent-bundle-mcp-runtime-config.js";

const mocks = vi.hoisted(() => ({
  diagnostics: [] as Array<{ pluginId: string; message: string }>,
  prepareDataDirsByServer: {} as Record<string, { pluginId: string; dataDir: string }>,
}));

vi.mock("./embedded-agent-mcp.js", () => ({
  loadEmbeddedAgentMcpConfig: (params: {
    cfg?: { mcp?: { servers?: Record<string, unknown> } };
    toolOverrides?: { mcpServers?: Record<string, boolean> };
  }) => {
    const servers = Object.fromEntries(
      Object.entries(params.cfg?.mcp?.servers ?? {}).filter(
        ([name]) => params.toolOverrides?.mcpServers?.[name] !== false,
      ),
    );
    return {
      diagnostics: structuredClone(mocks.diagnostics),
      mcpServers: servers,
      prepareDataDirsByServer: structuredClone(mocks.prepareDataDirsByServer),
    };
  },
}));

afterEach(() => {
  mocks.diagnostics = [];
  mocks.prepareDataDirsByServer = {};
  clearPluginMetadataLifecycleCaches();
});

describe("session MCP config projection", () => {
  it("keeps Agent Plugins launch ownership out of fingerprints and filtered partitions", () => {
    const cfg = {
      mcp: { servers: { alpha: { command: "alpha" }, beta: { command: "beta" } } },
    };
    mocks.prepareDataDirsByServer = {
      alpha: { pluginId: "agent-plugin", dataDir: "/state/one" },
      beta: { pluginId: "agent-plugin", dataDir: "/state/two" },
    };
    const first = loadSessionMcpConfig({ workspaceDir: "/ownership-workspace", cfg });
    const filtered = loadSessionMcpConfig({
      workspaceDir: "/ownership-workspace",
      cfg,
      includeServerNames: new Set(["alpha"]),
    });

    expect(first.loaded.prepareDataDirsByServer).toEqual({
      alpha: { pluginId: "agent-plugin", dataDir: "/state/one" },
      beta: { pluginId: "agent-plugin", dataDir: "/state/two" },
    });
    expect(filtered.loaded.prepareDataDirsByServer).toEqual({
      alpha: { pluginId: "agent-plugin", dataDir: "/state/one" },
    });
    clearPluginMetadataLifecycleCaches();
    mocks.prepareDataDirsByServer = {
      alpha: { pluginId: "agent-plugin", dataDir: "/different/state" },
    };
    const changedOwnership = loadSessionMcpConfig({ workspaceDir: "/ownership-workspace", cfg });
    expect(changedOwnership.fingerprint).toBe(first.fingerprint);
  });

  it("isolates full and filtered catalog preparation", () => {
    const cfg = {
      mcp: {
        servers: {
          alpha: { command: "alpha" },
          beta: { command: "beta" },
        },
      },
    };

    const full = loadSessionMcpConfig({ workspaceDir: "/reuse-workspace", cfg });
    const filtered = loadSessionMcpConfig({
      workspaceDir: "/reuse-workspace",
      cfg,
      includeServerNames: new Set(["alpha"]),
    });
    const filteredAgain = loadSessionMcpConfig({
      workspaceDir: "/reuse-workspace",
      cfg,
      includeServerNames: new Set(["alpha"]),
    });

    expect(filteredAgain).not.toBe(filtered);
    expect(filteredAgain).toEqual(filtered);
    expect(Object.keys(full.loaded.mcpServers)).toEqual(["alpha", "beta"]);
    expect(Object.keys(filtered.loaded.mcpServers)).toEqual(["alpha"]);
    expect(filtered.fingerprint).not.toBe(full.fingerprint);

    const alpha = filtered.loaded.mcpServers.alpha;
    expect(alpha).toBeDefined();
    if (!alpha) {
      throw new Error("expected filtered alpha server");
    }
    alpha.command = "mutated";
    const isolated = loadSessionMcpConfig({
      workspaceDir: "/reuse-workspace",
      cfg,
      includeServerNames: new Set(["alpha"]),
    });
    expect(isolated.loaded.mcpServers.alpha).toEqual({ command: "alpha" });
  });

  it("reflects config changes in catalog fingerprints", () => {
    const firstConfig = { mcp: { servers: { alpha: { command: "alpha" } } } };
    const secondConfig = { mcp: { servers: { beta: { command: "beta" } } } };
    const firstRegistry = { plugins: [] };
    const secondRegistry = { plugins: [] };

    const first = loadSessionMcpConfig({
      workspaceDir: "/workspace",
      cfg: firstConfig,
      manifestRegistry: firstRegistry,
    });
    const second = loadSessionMcpConfig({
      workspaceDir: "/workspace",
      cfg: secondConfig,
      manifestRegistry: firstRegistry,
    });
    loadSessionMcpConfig({
      workspaceDir: "/other-workspace",
      cfg: firstConfig,
      manifestRegistry: firstRegistry,
    });
    loadSessionMcpConfig({
      workspaceDir: "/workspace",
      cfg: firstConfig,
      manifestRegistry: secondRegistry,
    });

    expect(first.fingerprint).not.toBe(second.fingerprint);
  });

  it("isolates server overrides across sessions on the same agent", () => {
    const cfg = { mcp: { servers: { docs: { command: "docs" } } } };
    const disabled = loadSessionMcpConfig({
      workspaceDir: "/same-agent-workspace",
      cfg,
      toolOverrides: { mcpServers: { docs: false } },
    });
    const enabled = loadSessionMcpConfig({
      workspaceDir: "/same-agent-workspace",
      cfg,
      toolOverrides: { mcpServers: { docs: true } },
    });
    const disabledAgain = loadSessionMcpConfig({
      workspaceDir: "/same-agent-workspace",
      cfg,
      toolOverrides: { mcpServers: { docs: false } },
    });

    expect(Object.keys(disabled.loaded.mcpServers)).toEqual([]);
    expect(Object.keys(enabled.loaded.mcpServers)).toEqual(["docs"]);
    expect(disabledAgain).toEqual(disabled);
  });

  it("isolates nested launch config values from later config mutations", () => {
    const cfg = {
      mcp: {
        servers: {
          alpha: { command: "alpha", args: ["original"], env: { MODE: "original" } },
        },
      },
    };

    loadSessionMcpConfig({ workspaceDir: "/snapshot-workspace", cfg });
    cfg.mcp.servers.alpha.args[0] = "mutated";
    cfg.mcp.servers.alpha.env.MODE = "mutated";
    const isolated = loadSessionMcpConfig({
      workspaceDir: "/snapshot-workspace",
      cfg: {
        mcp: {
          servers: {
            alpha: { command: "alpha", args: ["original"], env: { MODE: "original" } },
          },
        },
      },
    });

    expect(isolated.loaded.mcpServers.alpha).toEqual({
      command: "alpha",
      args: ["original"],
      env: { MODE: "original" },
    });
  });

  it("reports the current metadata diagnostics", () => {
    const cfg = { mcp: { servers: { alpha: { command: "alpha" } } } };
    mocks.diagnostics = [{ pluginId: "example", message: "temporary read failure" }];

    expect(
      loadSessionMcpConfig({ workspaceDir: "/retry-workspace", cfg, logDiagnostics: false }).loaded
        .diagnostics,
    ).toEqual(mocks.diagnostics);
    mocks.diagnostics = [];
    expect(
      loadSessionMcpConfig({ workspaceDir: "/retry-workspace", cfg, logDiagnostics: false }).loaded
        .diagnostics,
    ).toEqual([]);
  });
});
