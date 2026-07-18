/** Tests process-wide caching for immutable bundled MCP config discovery. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { loadSessionMcpConfig } from "./agent-bundle-mcp-runtime-config.js";

const mocks = vi.hoisted(() => ({
  loadCount: 0,
  diagnostics: [] as Array<{ pluginId: string; message: string }>,
}));

vi.mock("./embedded-agent-mcp.js", () => ({
  loadEmbeddedAgentMcpConfig: (params: {
    cfg?: { mcp?: { servers?: Record<string, unknown> } };
  }) => {
    mocks.loadCount += 1;
    return {
      diagnostics: structuredClone(mocks.diagnostics),
      mcpServers: params.cfg?.mcp?.servers ?? {},
    };
  },
}));

afterEach(() => {
  mocks.loadCount = 0;
  mocks.diagnostics = [];
  clearPluginMetadataLifecycleCaches();
});

describe("session MCP config discovery cache", () => {
  it("reuses immutable discovery across full and filtered catalog preparation", () => {
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

    expect(mocks.loadCount).toBe(1);
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

  it("invalidates discovery when config, workspace, or manifest snapshot changes", () => {
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

    expect(mocks.loadCount).toBe(4);
    expect(first.fingerprint).not.toBe(second.fingerprint);
  });

  it("snapshots nested config values at the cache boundary", () => {
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

  it("reloads discovery after plugin metadata lifecycle invalidation", () => {
    const cfg = { mcp: { servers: { alpha: { command: "alpha" } } } };

    loadSessionMcpConfig({ workspaceDir: "/reload-workspace", cfg });
    clearPluginMetadataLifecycleCaches();
    loadSessionMcpConfig({ workspaceDir: "/reload-workspace", cfg });

    expect(mocks.loadCount).toBe(2);
  });

  it("retries discovery after a diagnostic result", () => {
    const cfg = { mcp: { servers: { alpha: { command: "alpha" } } } };
    mocks.diagnostics = [{ pluginId: "example", message: "temporary read failure" }];

    loadSessionMcpConfig({ workspaceDir: "/retry-workspace", cfg, logDiagnostics: false });
    mocks.diagnostics = [];
    loadSessionMcpConfig({ workspaceDir: "/retry-workspace", cfg, logDiagnostics: false });
    loadSessionMcpConfig({ workspaceDir: "/retry-workspace", cfg, logDiagnostics: false });

    expect(mocks.loadCount).toBe(2);
  });
});
