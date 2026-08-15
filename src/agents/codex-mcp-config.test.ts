// Covers conversion from OpenClaw bundle-MCP config into Codex app-server
// thread config patches.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildCodexMcpServersConfig,
  loadCodexBundleMcpThreadConfigCore,
} from "./codex-mcp-config.js";
import { testing as resolverTesting } from "./mcp-connection-resolver.js";

const mocks = vi.hoisted(() => ({
  loadCalls: [] as Array<Record<string, unknown>>,
  bundleMcp: {
    config: {
      mcpServers: {},
    },
    diagnostics: [],
  },
}));
const tempDirs: string[] = [];

vi.mock("../plugins/bundle-mcp.js", () => ({
  loadEnabledBundleMcpConfig: (params: Record<string, unknown>) => {
    mocks.loadCalls.push(params);
    return mocks.bundleMcp;
  },
}));

beforeEach(() => {
  mocks.loadCalls.length = 0;
  mocks.bundleMcp = {
    config: {
      mcpServers: {},
    },
    diagnostics: [],
  };
});

afterEach(async () => {
  resolverTesting.setMcpServerConnectionResolversForTest();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
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

describe("loadCodexBundleMcpThreadConfigCore", () => {
  it("forwards a prepared manifest registry to bundle loading", () => {
    const manifestRegistry = { plugins: [] };

    loadCodexBundleMcpThreadConfigCore({ workspaceDir: "/workspace", manifestRegistry });

    expect(mocks.loadCalls).toEqual([
      expect.objectContaining({ workspaceDir: "/workspace", manifestRegistry }),
    ]);
  });

  it("prepares Agent Plugins data dirs before projecting Codex thread config", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-agent-mcp-"));
    tempDirs.push(tempDir);
    const dataDir = path.join(tempDir, "plugin-data");
    const collisionPath = path.join(tempDir, "plugin-data-collision");
    await fs.writeFile(collisionPath, "not a directory", "utf8");
    Object.assign(mocks.bundleMcp, {
      config: {
        mcpServers: {
          weather: {
            command: "node",
            env: { PLUGIN_DATA: dataDir },
          },
          broken: { command: "node", env: { PLUGIN_DATA: collisionPath } },
        },
      },
      diagnostics: [],
      prepareDataDirsByServer: {
        weather: { pluginId: "weather-plugin", dataDir },
        broken: { pluginId: "broken-plugin", dataDir: collisionPath },
      },
    });

    const loaded = loadCodexBundleMcpThreadConfigCore({ workspaceDir: "/workspace" });

    expect((await fs.stat(dataDir)).isDirectory()).toBe(true);
    expect(loaded.configPatch?.mcp_servers.weather).toMatchObject({ command: "node" });
    expect(loaded.configPatch?.mcp_servers.broken).toBeUndefined();
    expect(loaded.diagnostics).toEqual([
      expect.objectContaining({
        pluginId: "broken-plugin",
        message: expect.stringMatching(/unable to prepare PLUGIN_DATA.*EEXIST/iu),
      }),
    ]);
  });

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

    const loaded = loadCodexBundleMcpThreadConfigCore({
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
    expect(loaded.staticServerNames).toEqual(["search"]);
  });

  it("applies session server and tool denials to bundled Codex MCP config", () => {
    mocks.bundleMcp = {
      config: {
        mcpServers: {
          docs: {
            type: "http",
            url: "https://docs.example.com/mcp",
            toolFilter: { exclude: ["delete_all"] },
          },
          constructor: { type: "http", url: "https://constructor.example.com/mcp" },
          search: { type: "http", url: "https://search.example.com/mcp" },
        },
      },
      diagnostics: [],
    };

    const loaded = loadCodexBundleMcpThreadConfigCore({
      workspaceDir: "/workspace",
      cfg: {},
      toolOverrides: {
        mcpServers: { search: false },
        mcpToolsDeny: { docs: ["delete_page"] },
      },
    });

    expect(loaded.configPatch).toEqual({
      mcp_servers: {
        constructor: {
          url: "https://constructor.example.com/mcp",
        },
        docs: {
          url: "https://docs.example.com/mcp",
          disabled_tools: ["delete_all", "delete_page"],
        },
      },
    });
  });

  it("lets user config disable a same-named bundled server unless the session enables it", () => {
    mocks.bundleMcp = {
      config: {
        mcpServers: {
          docs: { type: "http", url: "https://bundled.example.com/mcp" },
        },
      },
      diagnostics: [],
    };
    const cfg = {
      mcp: {
        servers: {
          docs: { enabled: false, url: "https://configured.example.com/mcp" },
        },
      },
    };

    expect(
      loadCodexBundleMcpThreadConfigCore({ workspaceDir: "/workspace", cfg }).configPatch,
    ).toBeUndefined();
    expect(
      loadCodexBundleMcpThreadConfigCore({
        workspaceDir: "/workspace",
        cfg,
        toolOverrides: { mcpServers: { docs: true } },
      }).configPatch,
    ).toEqual({
      mcp_servers: {
        docs: { url: "https://bundled.example.com/mcp" },
      },
    });
  });

  it("leaves user mcp.servers to the Codex user MCP projection path", () => {
    // User MCP config is projected elsewhere; this loader only injects bundled
    // MCP servers so the same server does not appear twice in Codex.
    const loaded = loadCodexBundleMcpThreadConfigCore({
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
    expect(loaded.staticServerNames).toEqual(["search"]);
    expect(loaded.userStaticServerNames).toEqual(["search"]);
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
      const loaded = loadCodexBundleMcpThreadConfigCore({
        workspaceDir: "/workspace",
        cfg,
        ...params,
      });

      expect(loaded.configPatch).toBeUndefined();
      expect(loaded.fingerprint).toBeUndefined();
      expect(loaded.evaluated).toBe(true);
      expect(loaded.staticServerNames).toEqual([]);
    }
  });

  it("omits the config patch when no MCP servers are configured", () => {
    const loaded = loadCodexBundleMcpThreadConfigCore({
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

    const loaded = loadCodexBundleMcpThreadConfigCore({
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
    const withoutScopedConfig = loadCodexBundleMcpThreadConfigCore({
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
    expect(loaded.staticServerNames).toEqual(["search"]);
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

    const a = loadCodexBundleMcpThreadConfigCore({
      workspaceDir: "/workspace",
      cfg: {},
      toolsEnabled: true,
    });
    const b = loadCodexBundleMcpThreadConfigCore({
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
