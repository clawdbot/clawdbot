// MCP CLI OAuth tests cover credential status, login callbacks, and logout behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as mcpHttpFetch from "../agents/mcp-http-fetch.js";
import { withTempHome } from "../config/home-env.test-harness.js";
import {
  cleanupMcpCliTestState,
  clearMcpOAuthCredentials,
  createWorkspace,
  lastLogLine,
  mockLog,
  readMcpOAuthCredentialsStatus,
  resetMcpCliTestState,
  runMcpCommand,
  runMcpOAuthLogin,
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
        hasTokens: true,
        requiresAuthorization: false,
        hasClientInformation: true,
        hasCodeVerifier: false,
        hasDiscoveryState: true,
        hasLastAuthorizationUrl: true,
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
          hasTokens: true,
          requiresAuthorization: false,
          hasClientInformation: true,
          hasCodeVerifier: false,
          hasDiscoveryState: true,
          hasLastAuthorizationUrl: true,
        },
      });
    });
  });

  it("surfaces required OAuth authorization in status and doctor", async () => {
    await withTempHome("openclaw-cli-mcp-home-", async () => {
      const workspaceDir = await createWorkspace();
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);
      readMcpOAuthCredentialsStatus.mockResolvedValue({
        hasTokens: true,
        requiresAuthorization: true,
        hasClientInformation: true,
        hasCodeVerifier: false,
        hasDiscoveryState: true,
        hasLastAuthorizationUrl: true,
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
      expect(statusLines).toContain("  oauth: tokens=yes authorization=required client=yes");

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

  it("configures enablement, timeouts, and OAuth login", async () => {
    await withTempHome("openclaw-cli-mcp-home-", async () => {
      const workspaceDir = await createWorkspace();
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);
      const buildMcpHttpFetch = vi.spyOn(mcpHttpFetch, "buildMcpHttpFetch");
      runMcpOAuthLogin.mockResolvedValueOnce("authorized");

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

      expect(buildMcpHttpFetch).toHaveBeenCalledWith(
        expect.objectContaining({
          resourceUrl: "https://mcp.example.com",
          timeoutMs: 9_000,
        }),
      );
      expect(runMcpOAuthLogin).toHaveBeenCalledWith({
        serverName: "docs",
        serverUrl: "https://mcp.example.com",
        config: undefined,
        fetchFn: expect.any(Function),
        authorizationCode: "abc123",
      });

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

      expect(clearMcpOAuthCredentials).toHaveBeenCalledWith({
        serverName: "docs",
        serverUrl: "https://mcp.example.com",
      });
      expect(lastLogLine()).toBe('MCP OAuth credentials cleared for "docs".');
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

      expect(clearMcpOAuthCredentials).toHaveBeenCalledWith({
        serverName: "docs",
        serverUrl: "https://mcp.example.com",
      });
    });
  });
});
