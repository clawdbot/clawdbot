import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildCodexUserMcpServersThreadConfigPatch } from "./bundle-mcp-codex.js";

describe("buildCodexUserMcpServersThreadConfigPatch", () => {
  it("returns undefined when cfg has no mcp.servers (regression: #80814)", () => {
    expect(buildCodexUserMcpServersThreadConfigPatch(undefined)).toBeUndefined();
    expect(buildCodexUserMcpServersThreadConfigPatch({} as OpenClawConfig)).toBeUndefined();
    expect(
      buildCodexUserMcpServersThreadConfigPatch({ mcp: {} } as OpenClawConfig),
    ).toBeUndefined();
    expect(
      buildCodexUserMcpServersThreadConfigPatch({ mcp: { servers: {} } } as OpenClawConfig),
    ).toBeUndefined();
  });

  it("projects a stdio user MCP server entry into mcp_servers (regression: #80814)", () => {
    const patch = buildCodexUserMcpServersThreadConfigPatch({
      mcp: {
        servers: {
          outlook: {
            transport: "stdio",
            command: "node",
            args: ["/opt/outlook-mcp/dist/index.js"],
            env: { OUTLOOK_USER: "alice@example.org" },
          },
        },
      },
    } as unknown as OpenClawConfig);
    expect(patch).toStrictEqual({
      mcp_servers: {
        outlook: {
          command: "node",
          args: ["/opt/outlook-mcp/dist/index.js"],
          env: { OUTLOOK_USER: "alice@example.org" },
        },
      },
    });
  });

  it("projects a streamable-http user MCP server with bearer auth into mcp_servers", () => {
    const patch = buildCodexUserMcpServersThreadConfigPatch({
      mcp: {
        servers: {
          notes: {
            transport: "streamable-http",
            url: "https://notes.example.org/mcp",
            headers: {
              Authorization: "Bearer ${NOTES_TOKEN}",
              "x-tenant": "${NOTES_TENANT}",
            },
          },
        },
      },
    } as unknown as OpenClawConfig);
    expect(patch).toStrictEqual({
      mcp_servers: {
        notes: {
          url: "https://notes.example.org/mcp",
          bearer_token_env_var: "NOTES_TOKEN",
          env_http_headers: { "x-tenant": "NOTES_TENANT" },
        },
      },
    });
  });

  it("projects Codex-specific default tool approval mode", () => {
    const patch = buildCodexUserMcpServersThreadConfigPatch({
      mcp: {
        servers: {
          search: {
            transport: "streamable-http",
            url: "https://mcp.example.com/mcp",
            codex: {
              defaultToolsApprovalMode: "approve",
            },
          },
        },
      },
    } as unknown as OpenClawConfig);
    expect(patch).toStrictEqual({
      mcp_servers: {
        search: {
          url: "https://mcp.example.com/mcp",
          default_tools_approval_mode: "approve",
        },
      },
    });
  });

  it("uses the Codex-native approval spelling when configured", () => {
    const patch = buildCodexUserMcpServersThreadConfigPatch({
      mcp: {
        servers: {
          search: {
            transport: "streamable-http",
            url: "https://mcp.example.com/mcp",
            codex: {
              default_tools_approval_mode: "prompt",
            },
          },
        },
      },
    } as unknown as OpenClawConfig);
    expect(patch?.mcp_servers.search).toMatchObject({
      url: "https://mcp.example.com/mcp",
      default_tools_approval_mode: "prompt",
    });
  });

  it("filters Codex-scoped user MCP servers by OpenClaw agent id", () => {
    const cfg = {
      mcp: {
        servers: {
          atlas: {
            transport: "streamable-http",
            url: "https://atlas.example.com/mcp",
            codex: { agents: ["atlas"] },
          },
          apolo: {
            transport: "streamable-http",
            url: "https://apolo.example.com/mcp",
            codex: { agents: ["apolo"] },
          },
          global: {
            transport: "stdio",
            command: "node",
            args: ["global-mcp.js"],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const atlasPatch = buildCodexUserMcpServersThreadConfigPatch(cfg, { agentId: "atlas" });
    expect(Object.keys(atlasPatch!.mcp_servers).toSorted()).toEqual(["atlas", "global"]);
    expect(atlasPatch!.mcp_servers.atlas).toMatchObject({ url: "https://atlas.example.com/mcp" });
    expect(atlasPatch!.mcp_servers.global).toMatchObject({
      command: "node",
      args: ["global-mcp.js"],
    });

    const apoloPatch = buildCodexUserMcpServersThreadConfigPatch(cfg, { agentId: "apolo" });
    expect(Object.keys(apoloPatch!.mcp_servers).toSorted()).toEqual(["apolo", "global"]);
    expect(apoloPatch!.mcp_servers.apolo).toMatchObject({ url: "https://apolo.example.com/mcp" });
  });

  it("returns undefined when all user MCP servers are scoped to other agents", () => {
    const patch = buildCodexUserMcpServersThreadConfigPatch(
      {
        mcp: {
          servers: {
            atlas: {
              transport: "streamable-http",
              url: "https://atlas.example.com/mcp",
              codex: { agents: ["atlas"] },
            },
          },
        },
      } as unknown as OpenClawConfig,
      { agentId: "apolo" },
    );
    expect(patch).toBeUndefined();
  });

  it("normalizes Codex agent scopes before matching", () => {
    const patch = buildCodexUserMcpServersThreadConfigPatch(
      {
        mcp: {
          servers: {
            atlas: {
              transport: "streamable-http",
              url: "https://atlas.example.com/mcp",
              codex: { agents: ["Atlas"] },
            },
          },
        },
      } as unknown as OpenClawConfig,
      { agentId: "ATLAS" },
    );
    expect(patch?.mcp_servers.atlas).toMatchObject({
      url: "https://atlas.example.com/mcp",
    });
  });

  it("fails closed for empty or invalid Codex agent scopes", () => {
    const cfg = {
      mcp: {
        servers: {
          empty: {
            transport: "streamable-http",
            url: "https://empty.example.com/mcp",
            codex: { agents: [] },
          },
          blank: {
            transport: "streamable-http",
            url: "https://blank.example.com/mcp",
            codex: { agents: ["  "] },
          },
          invalid: {
            transport: "streamable-http",
            url: "https://invalid.example.com/mcp",
            codex: { agents: ["", 1, null, "!!!", "-main-"] },
          },
          global: {
            transport: "stdio",
            command: "node",
            args: ["global-mcp.js"],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const patch = buildCodexUserMcpServersThreadConfigPatch(cfg, { agentId: "atlas" });
    expect(patch).toStrictEqual({
      mcp_servers: {
        global: {
          command: "node",
          args: ["global-mcp.js"],
        },
      },
    });
  });

  it("omits scoped Codex MCP servers when no OpenClaw agent id is available", () => {
    const patch = buildCodexUserMcpServersThreadConfigPatch({
      mcp: {
        servers: {
          atlas: {
            transport: "streamable-http",
            url: "https://atlas.example.com/mcp",
            codex: { agents: ["atlas"] },
          },
        },
      },
    } as unknown as OpenClawConfig);
    expect(patch).toBeUndefined();
  });

  it("preserves multiple user MCP servers as independent mcp_servers entries", () => {
    const patch = buildCodexUserMcpServersThreadConfigPatch({
      mcp: {
        servers: {
          one: { transport: "stdio", command: "one" },
          two: { transport: "stdio", command: "two" },
        },
      },
    } as unknown as OpenClawConfig);
    expect(patch?.mcp_servers).toBeDefined();
    expect(Object.keys(patch!.mcp_servers).toSorted()).toEqual(["one", "two"]);
    expect(patch!.mcp_servers.one).toMatchObject({ command: "one" });
    expect(patch!.mcp_servers.two).toMatchObject({ command: "two" });
  });
});
