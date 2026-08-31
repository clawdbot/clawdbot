// MCP CLI OAuth tests cover credential status, login callbacks, and logout behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTempHome } from "../config/home-env.test-harness.js";
import {
  cleanupMcpCliTestState,
  clearMcpOAuthCredentials,
  countMcpOAuthPrincipals,
  completeMcpOAuthAuthorization,
  createWorkspace,
  lastErrorLine,
  lastLogLine,
  mockError,
  mockLog,
  readMcpOAuthCredentialsStatus,
  resetMcpCliTestState,
  runMcpCommand,
} from "./mcp-cli.test-harness.js";

describe("mcp cli OAuth", () => {
  beforeEach(() => {
    resetMcpCliTestState();
  });

  afterEach(async () => {
    await cleanupMcpCliTestState();
  });

  it("includes OAuth credential status in MCP status output", async () => {
    await withTempHome("openclaw-cli-mcp-home-", async () => {
      const workspaceDir = await createWorkspace();
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);
      readMcpOAuthCredentialsStatus.mockResolvedValueOnce({
        state: "authorized",
      });

      await runMcpCommand([
        "mcp",
        "set",
        "docs",
        '{"url":"https://mcp.example.com","transport":"streamable-http","auth":"oauth"}',
      ]);
      mockLog.mockClear();

      await runMcpCommand(["mcp", "status", "--json"]);

      expect(JSON.parse(lastLogLine()).servers[0]).toMatchObject({
        name: "docs",
        auth: "oauth",
        authStatus: {
          hasTokens: false,
          state: "authorized",
        },
      });
    });
  });

  it("surfaces required OAuth authorization in status and doctor", async () => {
    await withTempHome("openclaw-cli-mcp-home-", async () => {
      const workspaceDir = await createWorkspace();
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);
      readMcpOAuthCredentialsStatus.mockResolvedValue({
        state: "requires-authorization",
      });

      await runMcpCommand([
        "mcp",
        "set",
        "docs",
        '{"url":"https://mcp.example.com","transport":"streamable-http","auth":"oauth"}',
      ]);
      mockLog.mockClear();

      await runMcpCommand(["mcp", "status", "--verbose"]);

      const statusLines = mockLog.mock.calls.map((call) => String(call[0]));
      expect(statusLines).toContain("- docs: streamable-http oauth authorization-required");
      expect(statusLines).toContain("  oauth: requires-authorization");

      mockLog.mockClear();
      await runMcpCommand(["mcp", "doctor", "--json"]);

      expect(JSON.parse(lastLogLine())).toMatchObject({
        ok: true,
        servers: [
          {
            name: "docs",
            ok: true,
            issues: [
              {
                level: "warning",
                message:
                  "OAuth credentials require additional authorization; run openclaw mcp login docs",
              },
            ],
          },
        ],
      });
    });
  });

  it("shows connected requester principals in list and status output", async () => {
    await withTempHome("openclaw-cli-mcp-home-", async () => {
      const workspaceDir = await createWorkspace();
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);
      countMcpOAuthPrincipals.mockReturnValue(2);

      await runMcpCommand([
        "mcp",
        "set",
        "calendar",
        '{"url":"https://mcp.example.com","transport":"streamable-http","auth":"oauth","oauth":{"identity":"per-requester"}}',
      ]);
      mockLog.mockClear();

      await runMcpCommand(["mcp", "list"]);
      expect(mockLog.mock.calls.map(([line]) => String(line))).toContain(
        "- calendar (2 connected principals)",
      );

      mockLog.mockClear();
      await runMcpCommand(["mcp", "status", "--json"]);
      expect(JSON.parse(lastLogLine()).servers[0]).toMatchObject({
        name: "calendar",
        connectedPrincipals: 2,
      });
      expect(readMcpOAuthCredentialsStatus).not.toHaveBeenCalled();
    });
  });

  it("configures enablement, timeouts, and OAuth login", async () => {
    await withTempHome("openclaw-cli-mcp-home-", async () => {
      const workspaceDir = await createWorkspace();
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);
      completeMcpOAuthAuthorization.mockResolvedValueOnce("authorized");

      await runMcpCommand([
        "mcp",
        "set",
        "docs",
        '{"url":"https://mcp.example.com","transport":"streamable-http"}',
      ]);
      await runMcpCommand([
        "mcp",
        "configure",
        "docs",
        "--disable",
        "--timeout",
        "9",
        "--auth",
        "oauth",
      ]);
      await runMcpCommand(["mcp", "login", "docs", "--code", "abc123"]);

      expect(completeMcpOAuthAuthorization).toHaveBeenCalledWith(
        expect.objectContaining({
          serverName: "docs",
          serverUrl: "https://mcp.example.com",
        }),
        expect.objectContaining({ url: "https://mcp.example.com" }),
        { code: "abc123" },
      );

      mockLog.mockClear();
      await runMcpCommand(["mcp", "status", "--json"]);
      expect(JSON.parse(lastLogLine()).servers[0]).toMatchObject({
        name: "docs",
        enabled: false,
        ok: false,
        requestTimeoutMs: 9_000,
        auth: "oauth",
      });
    });
  });

  it("clears stored OAuth credentials on logout", async () => {
    await withTempHome("openclaw-cli-mcp-home-", async () => {
      const workspaceDir = await createWorkspace();
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);

      await runMcpCommand([
        "mcp",
        "set",
        "docs",
        '{"url":"https://mcp.example.com","transport":"streamable-http","auth":"oauth"}',
      ]);
      clearMcpOAuthCredentials.mockClear();
      await runMcpCommand(["mcp", "logout", "docs"]);

      expect(clearMcpOAuthCredentials).toHaveBeenCalledWith(
        expect.objectContaining({
          serverName: "docs",
          serverUrl: "https://mcp.example.com",
        }),
      );
      expect(lastLogLine()).toBe('MCP OAuth credentials cleared for "docs".');
    });
  });

  it.each([
    {
      name: "per-requester identity and redirect metadata",
      oauth: {
        identity: "per-requester",
        scope: "docs.read",
        redirectUrl: "https://gateway.example.com/oauth/mcp/callback",
        clientMetadataUrl: "https://gateway.example.com/oauth/mcp.json",
      },
    },
    {
      name: "auth-profile binding",
      oauth: { authProfileId: "docs:mcp", scope: "docs.read" },
    },
  ])("preserves $name when updating OAuth scope", async ({ oauth }) => {
    await withTempHome("openclaw-cli-mcp-home-", async () => {
      const workspaceDir = await createWorkspace();
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);
      await runMcpCommand([
        "mcp",
        "set",
        "docs",
        JSON.stringify({
          url: "https://mcp.example.com",
          transport: "streamable-http",
          auth: "oauth",
          oauth,
          toolFilter: { include: ["old_*"], exclude: ["admin_*"] },
        }),
      ]);

      await runMcpCommand([
        "mcp",
        "configure",
        "docs",
        "--oauth-scope",
        "docs.write",
        "--include",
        "search",
      ]);

      mockLog.mockClear();
      await runMcpCommand(["mcp", "show", "docs", "--json"]);
      expect(JSON.parse(lastLogLine())).toMatchObject({
        oauth: { ...oauth, scope: "docs.write" },
        toolFilter: { include: ["search"], exclude: ["admin_*"] },
      });
    });
  });

  it("does not restore previous OAuth metadata after an explicit clear", async () => {
    await withTempHome("openclaw-cli-mcp-home-", async () => {
      const workspaceDir = await createWorkspace();
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);
      await runMcpCommand([
        "mcp",
        "set",
        "docs",
        JSON.stringify({
          url: "https://mcp.example.com",
          auth: "oauth",
          oauth: { authProfileId: "docs:mcp", scope: "docs.read" },
        }),
      ]);

      await runMcpCommand([
        "mcp",
        "configure",
        "docs",
        "--clear-auth",
        "--auth",
        "oauth",
        "--oauth-scope",
        "docs.write",
      ]);

      mockLog.mockClear();
      await runMcpCommand(["mcp", "show", "docs", "--json"]);
      expect(JSON.parse(lastLogLine()).oauth).toEqual({ scope: "docs.write" });
    });
  });

  it("rejects operator login and logout for per-requester OAuth", async () => {
    await withTempHome("openclaw-cli-mcp-home-", async () => {
      const workspaceDir = await createWorkspace();
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);
      await runMcpCommand([
        "mcp",
        "set",
        "calendar",
        '{"url":"https://mcp.example.com","transport":"streamable-http","auth":"oauth","oauth":{"identity":"per-requester"}}',
      ]);
      mockError.mockClear();
      completeMcpOAuthAuthorization.mockClear();
      clearMcpOAuthCredentials.mockClear();

      await expect(runMcpCommand(["mcp", "login", "calendar", "--code", "abc123"])).rejects.toThrow(
        "__exit__:1",
      );
      expect(lastErrorLine()).toBe(
        'MCP server "calendar" uses per-requester OAuth. Senders connect from the channel via the MCP connect flow.',
      );
      expect(completeMcpOAuthAuthorization).not.toHaveBeenCalled();

      mockError.mockClear();
      await expect(runMcpCommand(["mcp", "logout", "calendar"])).rejects.toThrow("__exit__:1");
      expect(lastErrorLine()).toBe(
        'MCP server "calendar" uses per-requester OAuth. Remove or replace the server to clear requester credentials.',
      );
      expect(clearMcpOAuthCredentials).not.toHaveBeenCalled();
    });
  });

  it("clears stored OAuth credentials after auth is removed", async () => {
    await withTempHome("openclaw-cli-mcp-home-", async () => {
      const workspaceDir = await createWorkspace();
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);

      await runMcpCommand([
        "mcp",
        "set",
        "docs",
        '{"url":"https://mcp.example.com","transport":"streamable-http"}',
      ]);
      clearMcpOAuthCredentials.mockClear();
      await runMcpCommand(["mcp", "logout", "docs"]);

      expect(clearMcpOAuthCredentials).toHaveBeenCalledWith(
        expect.objectContaining({
          serverName: "docs",
          serverUrl: "https://mcp.example.com",
        }),
      );
    });
  });
});
