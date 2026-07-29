/** Tests projecting OpenClaw user MCP servers into Codex app-server config. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  buildCodexUserMcpServersThreadConfigPatch,
  buildCodexUserMcpServersThreadConfigPatchForRuntime,
} from "./bundle-mcp-codex.js";

const authMocks = vi.hoisted(() => ({
  loadAuthProfileStoreForSecretsRuntime: vi.fn(),
  resolveApiKeyForProfile: vi.fn(),
  resolveMcpOAuthAccessToken: vi.fn(),
}));

vi.mock("../auth-profiles/store.js", () => ({
  loadAuthProfileStoreForSecretsRuntime: authMocks.loadAuthProfileStoreForSecretsRuntime,
}));

vi.mock("../auth-profiles/oauth.js", () => ({
  resolveApiKeyForProfile: authMocks.resolveApiKeyForProfile,
}));

vi.mock("../mcp-oauth.js", () => ({
  resolveMcpOAuthAccessToken: authMocks.resolveMcpOAuthAccessToken,
}));

describe("buildCodexUserMcpServersThreadConfigPatch", () => {
  beforeEach(() => {
    authMocks.loadAuthProfileStoreForSecretsRuntime.mockReset();
    authMocks.resolveApiKeyForProfile.mockReset();
    authMocks.resolveMcpOAuthAccessToken.mockReset();
  });

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

  it("projects exact OpenClaw MCP tool filters into Codex-native tool filters", () => {
    const patch = buildCodexUserMcpServersThreadConfigPatch({
      mcp: {
        servers: {
          docs: {
            transport: "streamable-http",
            url: "https://docs.example.com/mcp",
            toolFilter: {
              include: ["search_docs", "read_docs"],
              exclude: ["delete_docs"],
            },
          },
        },
      },
    } as unknown as OpenClawConfig);
    expect(patch).toStrictEqual({
      mcp_servers: {
        docs: {
          url: "https://docs.example.com/mcp",
          enabled_tools: ["search_docs", "read_docs"],
          disabled_tools: ["delete_docs"],
        },
      },
    });
  });

  it("rejects wildcard OpenClaw MCP tool filters that Codex cannot project exactly", () => {
    expect(() =>
      buildCodexUserMcpServersThreadConfigPatch({
        mcp: {
          servers: {
            docs: {
              transport: "streamable-http",
              url: "https://docs.example.com/mcp",
              toolFilter: {
                include: ["search_*"],
              },
            },
          },
        },
      } as unknown as OpenClawConfig),
    ).toThrow(
      'Cannot project mcp.servers.docs.toolFilter.include pattern "search_*" into Codex enabled_tools',
    );
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
    // Agent-scoped MCP servers should follow the active OpenClaw agent, while
    // unscoped servers remain global.
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

  it("omits disabled user MCP servers from Codex app-server projection", () => {
    const patch = buildCodexUserMcpServersThreadConfigPatch({
      mcp: {
        servers: {
          disabled: {
            enabled: false,
            transport: "streamable-http",
            url: "https://disabled.example.com/mcp",
          },
          enabled: {
            transport: "stdio",
            command: "node",
            args: ["enabled-mcp.js"],
          },
        },
      },
    } as unknown as OpenClawConfig);

    expect(patch).toStrictEqual({
      mcp_servers: {
        enabled: {
          command: "node",
          args: ["enabled-mcp.js"],
        },
      },
    });
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

  it("projects auth-profile backed user MCP servers with a fresh bearer header at runtime", async () => {
    authMocks.loadAuthProfileStoreForSecretsRuntime.mockReturnValueOnce({
      version: 1,
      profiles: {
        "ducktape:mcp": {
          type: "oauth",
          provider: "ducktape",
          access: "expired-access",
          refresh: "refresh-token-must-not-project",
          expires: 1,
        },
      },
    });
    authMocks.resolveApiKeyForProfile.mockResolvedValueOnce({
      apiKey: "fresh-access-token",
      provider: "ducktape",
      profileId: "ducktape:mcp",
      profileType: "oauth",
      credential: {
        type: "oauth",
        provider: "ducktape",
        access: "fresh-access-token",
        refresh: "refresh-token-must-not-project",
        expires: Date.now() + 60_000,
      },
    });

    const patch = await buildCodexUserMcpServersThreadConfigPatchForRuntime({
      mcp: {
        servers: {
          ducktape: {
            transport: "streamable-http",
            url: "https://agents.ducktape.xyz/mcp",
            auth: "oauth",
            oauth: { authProfileId: "ducktape:mcp" },
            headers: {
              Authorization: "Bearer stale-access",
              "x-tenant": "keep",
            },
          },
        },
      },
    } as unknown as OpenClawConfig);

    expect(patch).toStrictEqual({
      mcp_servers: {
        ducktape: {
          url: "https://agents.ducktape.xyz/mcp",
          http_headers: {
            Authorization: "Bearer fresh-access-token",
            "x-tenant": "keep",
          },
        },
      },
    });
    expect(JSON.stringify(patch)).not.toContain("refresh-token-must-not-project");
  });

  it("projects MCP-native OAuth credentials into local Codex runtime config", async () => {
    authMocks.resolveMcpOAuthAccessToken.mockResolvedValueOnce("native-access-token");

    const patch = await buildCodexUserMcpServersThreadConfigPatchForRuntime({
      mcp: {
        servers: {
          docs: {
            transport: "streamable-http",
            url: "https://mcp.example.com/mcp",
            auth: "oauth",
            oauth: { scope: "docs.read" },
          },
        },
      },
    } as unknown as OpenClawConfig);

    expect(patch).toStrictEqual({
      mcp_servers: {
        docs: {
          url: "https://mcp.example.com/mcp",
          http_headers: { Authorization: "Bearer native-access-token" },
        },
      },
    });
  });

  it("omits MCP-native OAuth servers that still need authorization", async () => {
    authMocks.resolveMcpOAuthAccessToken.mockRejectedValueOnce(
      new Error('MCP server "gbrain" requires OAuth authorization.'),
    );
    const onServerUnavailable = vi.fn();

    const patch = await buildCodexUserMcpServersThreadConfigPatchForRuntime(
      {
        mcp: {
          servers: {
            gbrain: {
              transport: "streamable-http",
              url: "https://gbrain.example.com/mcp",
              auth: "oauth",
            },
            localTools: {
              transport: "stdio",
              command: "local-tools",
            },
          },
        },
      } as unknown as OpenClawConfig,
      { onServerUnavailable },
    );

    expect(patch).toStrictEqual({
      mcp_servers: {
        localTools: { command: "local-tools" },
      },
    });
    expect(onServerUnavailable).toHaveBeenCalledWith("gbrain", expect.any(Error));
  });

  it("omits MCP-native OAuth projection from a remote Codex app-server", async () => {
    const onServerUnavailable = vi.fn();
    await expect(
      buildCodexUserMcpServersThreadConfigPatchForRuntime(
        {
          mcp: {
            servers: {
              docs: {
                transport: "streamable-http",
                url: "https://mcp.example.com/mcp",
                auth: "oauth",
              },
            },
          },
        } as unknown as OpenClawConfig,
        { allowLiteralOAuthProjection: false, onServerUnavailable },
      ),
    ).resolves.toBeUndefined();
    expect(onServerUnavailable).toHaveBeenCalledWith("docs", expect.any(Error));
    expect(authMocks.resolveMcpOAuthAccessToken).not.toHaveBeenCalled();
  });

  it("preserves tool filters while projecting auth-profile backed MCP bearers at runtime", async () => {
    authMocks.loadAuthProfileStoreForSecretsRuntime.mockReturnValueOnce({
      version: 1,
      profiles: {
        "ducktape:mcp": {
          type: "oauth",
          provider: "ducktape",
          access: "expired-access",
          refresh: "refresh-token-must-not-project",
          expires: 1,
        },
      },
    });
    authMocks.resolveApiKeyForProfile.mockResolvedValueOnce({
      apiKey: "fresh-access-token",
      provider: "ducktape",
      profileId: "ducktape:mcp",
      profileType: "oauth",
      credential: {
        type: "oauth",
        provider: "ducktape",
        access: "fresh-access-token",
        refresh: "refresh-token-must-not-project",
        expires: Date.now() + 60_000,
      },
    });

    const patch = await buildCodexUserMcpServersThreadConfigPatchForRuntime({
      mcp: {
        servers: {
          ducktape: {
            transport: "streamable-http",
            url: "https://agents.ducktape.xyz/mcp",
            auth: "oauth",
            oauth: { authProfileId: "ducktape:mcp" },
            headers: {
              Authorization: "Bearer stale-access",
            },
            toolFilter: {
              include: ["proof_echo", "proof_search"],
              exclude: ["admin_delete"],
            },
          },
        },
      },
    } as unknown as OpenClawConfig);

    expect(patch).toStrictEqual({
      mcp_servers: {
        ducktape: {
          url: "https://agents.ducktape.xyz/mcp",
          http_headers: {
            Authorization: "Bearer fresh-access-token",
          },
          enabled_tools: ["proof_echo", "proof_search"],
          disabled_tools: ["admin_delete"],
        },
      },
    });
    expect(JSON.stringify(patch)).not.toContain("refresh-token-must-not-project");
  });
});
