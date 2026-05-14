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
