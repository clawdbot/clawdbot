// Covers conversion from OpenClaw bundle-MCP config into Codex app-server
// thread config patches.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCodexMcpServersConfig, loadCodexBundleMcpThreadConfig } from "./codex-mcp-config.js";
import { testing as resolverTesting } from "./mcp-connection-resolver.js";

const mocks = vi.hoisted(() => ({
  bundleMcp: {
    config: {
      mcpServers: {},
    },
    diagnostics: [],
  },
}));

vi.mock("../plugins/bundle-mcp.js", () => ({
  loadEnabledBundleMcpConfig: () => mocks.bundleMcp,
}));

beforeEach(() => {
  mocks.bundleMcp = {
    config: {
      mcpServers: {},
    },
    diagnostics: [],
  };
});

afterEach(() => {
  resolverTesting.setMcpServerConnectionResolversForTest();
});

describe("buildCodexMcpServersConfig", () => {
  it("normalizes OpenClaw MCP servers into Codex app-server mcp_servers shape", () => {
    // Authorization is represented as Codex's bearer env var, while other env
    // placeholders become env_http_headers for per-thread substitution.
    expect(
      buildCodexMcpServersConfig({
        mcpServers: {
          openclaw: {
            type: "http",
            url: "http://127.0.0.1:23119/mcp",
            headers: {
              Authorization: "Bearer ${OPENCLAW_MCP_TOKEN}",
              "x-session-key": "${OPENCLAW_MCP_SESSION_KEY}",
              "x-static": "static-value",
            },
          },
        },
      }),
    ).toEqual({
      openclaw: {
        url: "http://127.0.0.1:23119/mcp",
        default_tools_approval_mode: "approve",
        bearer_token_env_var: "OPENCLAW_MCP_TOKEN",
        http_headers: {
          "x-static": "static-value",
        },
        env_http_headers: {
          "x-session-key": "OPENCLAW_MCP_SESSION_KEY",
        },
      },
    });
  });

  it("preserves Codex-specific MCP approval mode metadata", () => {
    expect(
      buildCodexMcpServersConfig({
        mcpServers: {
          search: {
            url: "https://mcp.example.com/mcp",
            codex: {
              defaultToolsApprovalMode: "prompt",
            },
          },
        },
      }),
    ).toEqual({
      search: {
        url: "https://mcp.example.com/mcp",
        default_tools_approval_mode: "prompt",
      },
    });
  });
});

describe("loadCodexBundleMcpThreadConfig", () => {
  it("loads enabled bundled MCP servers as a Codex thread config patch", () => {
    mocks.bundleMcp = {
      config: {
        mcpServers: {
          search: {
            type: "http",
            url: "https://mcp.example.com/mcp",
          },
        },
      },
      diagnostics: [],
    };

    const loaded = loadCodexBundleMcpThreadConfig({
      workspaceDir: "/workspace",
      cfg: {
        plugins: {
          entries: {
            "bundle-probe": { enabled: true },
          },
        },
      },
    });

    expect(loaded.configPatch).toEqual({
      mcp_servers: {
        search: {
          url: "https://mcp.example.com/mcp",
        },
      },
    });
    expect(loaded.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("leaves user mcp.servers to the Codex user MCP projection path", () => {
    // User MCP config is projected elsewhere; this loader only injects bundled
    // MCP servers so the same server does not appear twice in Codex.
    const loaded = loadCodexBundleMcpThreadConfig({
      workspaceDir: "/workspace",
      cfg: {
        mcp: {
          servers: {
            search: {
              transport: "streamable-http",
              url: "https://mcp.example.com/mcp",
            },
          },
        },
      },
      toolsEnabled: true,
    });

    expect(loaded.configPatch).toBeUndefined();
    expect(loaded.fingerprint).toBeUndefined();
    expect(loaded.evaluated).toBe(true);
  });

  it("returns an evaluated empty MCP config when no bundle MCP runtime is needed", () => {
    const cfg = {
      mcp: {
        servers: {
          search: {
            transport: "streamable-http",
            url: "https://mcp.example.com/mcp",
          },
        },
      },
    } as const;

    for (const params of [
      { toolsEnabled: false },
      { toolsEnabled: true, disableTools: true },
      { toolsEnabled: true, toolsAllow: [] },
      { toolsEnabled: true, toolsAllow: ["memory_search"] },
    ]) {
      const loaded = loadCodexBundleMcpThreadConfig({
        workspaceDir: "/workspace",
        cfg,
        ...params,
      });

      expect(loaded.configPatch).toBeUndefined();
      expect(loaded.fingerprint).toBeUndefined();
      expect(loaded.evaluated).toBe(true);
    }
  });

  it("omits the config patch when no MCP servers are configured", () => {
    const loaded = loadCodexBundleMcpThreadConfig({
      workspaceDir: "/workspace",
      cfg: {},
      toolsEnabled: true,
    });

    expect(loaded.configPatch).toBeUndefined();
    expect(loaded.fingerprint).toBeUndefined();
    expect(loaded.evaluated).toBe(true);
  });

  it("excludes requester-scoped servers from projection and fingerprint", () => {
    resolverTesting.setMcpServerConnectionResolversForTest([
      {
        serverName: "user-mail",
        resolve: async () => ({ url: "https://should-never-project.example/mcp" }),
      },
    ]);
    mocks.bundleMcp = {
      config: {
        mcpServers: {
          search: {
            type: "http",
            url: "https://mcp.example.com/mcp",
          },
          "user-mail": {
            type: "http",
            url: "https://unresolved.invalid",
          },
        },
      },
      diagnostics: [],
    };

    const loaded = loadCodexBundleMcpThreadConfig({
      workspaceDir: "/workspace",
      cfg: {},
      toolsEnabled: true,
    });
    // Same static set without a scoped entry must fingerprint identically.
    mocks.bundleMcp = {
      config: {
        mcpServers: {
          search: {
            type: "http",
            url: "https://mcp.example.com/mcp",
          },
        },
      },
      diagnostics: [],
    };
    const withoutScopedConfig = loadCodexBundleMcpThreadConfig({
      workspaceDir: "/workspace",
      cfg: {},
      toolsEnabled: true,
    });

    expect(loaded.configPatch).toEqual({
      mcp_servers: {
        search: {
          url: "https://mcp.example.com/mcp",
        },
      },
    });
    expect(JSON.stringify(loaded.configPatch)).not.toContain("unresolved.invalid");
    expect(JSON.stringify(loaded.configPatch)).not.toContain("user-mail");
    expect(loaded.configPatch).toEqual(withoutScopedConfig.configPatch);
    expect(loaded.fingerprint).toBe(withoutScopedConfig.fingerprint);
  });

  it("keeps static projection byte-identical when no resolver exists", () => {
    mocks.bundleMcp = {
      config: {
        mcpServers: {
          search: {
            type: "http",
            url: "https://mcp.example.com/mcp",
          },
        },
      },
      diagnostics: [],
    };

    const a = loadCodexBundleMcpThreadConfig({
      workspaceDir: "/workspace",
      cfg: {},
      toolsEnabled: true,
    });
    const b = loadCodexBundleMcpThreadConfig({
      workspaceDir: "/workspace",
      cfg: {},
      toolsEnabled: true,
    });
    expect(a.configPatch).toEqual(b.configPatch);
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.configPatch).toEqual({
      mcp_servers: {
        search: {
          url: "https://mcp.example.com/mcp",
        },
      },
    });
  });
});
