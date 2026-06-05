/** Tests merging bundled MCP defaults with OpenClaw user MCP configuration. */
import { describe, expect, it, vi } from "vitest";
import { loadMergedBundleMcpConfig, toCliBundleMcpServerConfig } from "./bundle-mcp-config.js";

const mocks = vi.hoisted(() => ({
  bundleMcp: {
    config: {
      mcpServers: {
        bundleProbe: {
          command: "node",
          args: ["./servers/probe.mjs"],
        },
      },
    },
    diagnostics: [],
  },
}));

vi.mock("../plugins/bundle-mcp.js", () => ({
  loadEnabledBundleMcpConfig: () => mocks.bundleMcp,
}));

describe("loadMergedBundleMcpConfig", () => {
  it("lets OpenClaw mcp.servers override bundle defaults while preserving raw transport shape", () => {
    const merged = loadMergedBundleMcpConfig({
      workspaceDir: "/workspace",
      cfg: {
        plugins: {
          entries: {
            "bundle-probe": { enabled: true },
          },
        },
        mcp: {
          servers: {
            bundleProbe: {
              transport: "streamable-http",
              url: "https://mcp.example.com/mcp",
            },
          },
        },
      },
    });

    expect(merged.config.mcpServers.bundleProbe).toEqual({
      transport: "streamable-http",
      url: "https://mcp.example.com/mcp",
    });
  });

  it("maps OpenClaw transports to downstream CLI types when requested", () => {
    expect(
      toCliBundleMcpServerConfig({
        transport: "streamable-http",
        url: "https://mcp.example.com/mcp",
      }),
    ).toEqual({
      type: "http",
      url: "https://mcp.example.com/mcp",
    });
    expect(toCliBundleMcpServerConfig({ type: "sse", transport: "streamable-http" })).toEqual({
      type: "sse",
    });
  });

  it("keeps disabled OpenClaw MCP servers out of embedded runtimes", () => {
    const merged = loadMergedBundleMcpConfig({
      workspaceDir: "/workspace",
      cfg: {
        mcp: {
          servers: {
            disabledDocs: {
              enabled: false,
              command: "node",
              args: ["docs.mjs"],
            },
          },
        },
      },
    });

    expect(merged.config.mcpServers).not.toHaveProperty("disabledDocs");
  });

  it("lets disabled OpenClaw MCP servers tombstone bundle defaults with the same name", () => {
    const merged = loadMergedBundleMcpConfig({
      workspaceDir: "/workspace",
      cfg: {
        mcp: {
          servers: {
            bundleProbe: {
              enabled: false,
            },
          },
        },
      },
    });

    expect(merged.config.mcpServers).not.toHaveProperty("bundleProbe");
  });
});
