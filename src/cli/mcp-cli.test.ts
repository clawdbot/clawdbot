import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTempHome } from "../config/home-env.test-harness.js";
import { registerMcpCli } from "./mcp-cli.js";

const mocks = vi.hoisted(() => {
  const runtime = {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn((code: number) => {
      throw new Error(`__exit__:${code}`);
    }),
    writeJson: vi.fn((value: unknown, space = 2) => {
      runtime.log(JSON.stringify(value, null, space > 0 ? space : undefined));
    }),
  };
  return {
    runtime,
    serveOpenClawChannelMcp: vi.fn(),
    clearMcpOAuthCredentials: vi.fn(),
    readMcpOAuthCredentialsStatus: vi.fn(),
    runMcpOAuthLogin: vi.fn(),
  };
});

const defaultRuntime = mocks.runtime;
const mockLog = defaultRuntime.log;
const mockError = defaultRuntime.error;
const serveOpenClawChannelMcp = mocks.serveOpenClawChannelMcp;
const clearMcpOAuthCredentials = mocks.clearMcpOAuthCredentials;
const readMcpOAuthCredentialsStatus = mocks.readMcpOAuthCredentialsStatus;
const runMcpOAuthLogin = mocks.runMcpOAuthLogin;

vi.mock("../runtime.js", () => ({
  defaultRuntime: mocks.runtime,
}));

vi.mock("../mcp/channel-server.js", () => ({
  serveOpenClawChannelMcp: mocks.serveOpenClawChannelMcp,
}));

vi.mock("../agents/mcp-oauth.js", () => ({
  clearMcpOAuthCredentials: mocks.clearMcpOAuthCredentials,
  readMcpOAuthCredentialsStatus: mocks.readMcpOAuthCredentialsStatus,
  runMcpOAuthLogin: mocks.runMcpOAuthLogin,
}));

const tempDirs: string[] = [];

async function createWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-mcp-"));
  tempDirs.push(dir);
  return dir;
}

let sharedProgram: Command;

async function runMcpCommand(args: string[]) {
  await sharedProgram.parseAsync(args, { from: "user" });
}

function lastLogLine(): string {
  return lastRuntimeLine(mockLog);
}

function lastErrorLine(): string {
  return lastRuntimeLine(mockError);
}

function lastRuntimeLine(mock: typeof mockLog): string {
  const call = mock.mock.calls[mock.mock.calls.length - 1];
  return String(call?.[0] ?? "");
}

describe("mcp cli", () => {
  if (!sharedProgram) {
    sharedProgram = new Command();
    sharedProgram.exitOverride();
    registerMcpCli(sharedProgram);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    readMcpOAuthCredentialsStatus.mockResolvedValue({
      hasTokens: false,
      hasClientInformation: false,
      hasCodeVerifier: false,
      hasDiscoveryState: false,
      hasLastAuthorizationUrl: false,
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("sets and shows a configured MCP server", async () => {
    await withTempHome("openclaw-cli-mcp-home-", async (home) => {
      const workspaceDir = await createWorkspace();
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);

      await runMcpCommand(["mcp", "set", "context7", '{"command":"uvx","args":["context7-mcp"]}']);
      expect(lastLogLine()).toBe(`Saved MCP server "context7" to ${configPath}.`);

      mockLog.mockClear();
      await runMcpCommand(["mcp", "show", "context7", "--json"]);
      expect(JSON.parse(lastLogLine())).toEqual({ command: "uvx", args: ["context7-mcp"] });
    });
  });

  it("adds a configured MCP server from flags without replacing operator knobs", async () => {
    await withTempHome("openclaw-cli-mcp-home-", async () => {
      const workspaceDir = await createWorkspace();
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);

      await runMcpCommand([
        "mcp",
        "add",
        "docs",
        "--url",
        "https://mcp.example.com/mcp",
        "--transport",
        "streamable-http",
        "--header",
        "Authorization=Bearer token",
        "--auth",
        "oauth",
        "--oauth-scope",
        "docs.read",
        "--include",
        "search,read_*",
        "--timeout",
        "12",
        "--connect-timeout",
        "3",
        "--parallel",
        "--no-probe",
      ]);

      mockLog.mockClear();
      await runMcpCommand(["mcp", "show", "docs", "--json"]);
      expect(JSON.parse(lastLogLine())).toEqual({
        url: "https://mcp.example.com/mcp",
        transport: "streamable-http",
        headers: { Authorization: "Bearer token" },
        auth: "oauth",
        oauth: { scope: "docs.read" },
        toolFilter: { include: ["search", "read_*"] },
        timeout: 12,
        connectTimeout: 3,
        supportsParallelToolCalls: true,
      });
    });
  });

  it("updates per-server MCP tool filters", async () => {
    await withTempHome("openclaw-cli-mcp-home-", async (home) => {
      const workspaceDir = await createWorkspace();
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);

      await runMcpCommand(["mcp", "set", "docs", '{"command":"node","args":["server.mjs"]}']);
      await runMcpCommand([
        "mcp",
        "tools",
        "docs",
        "--include",
        "search,read_*",
        "--exclude",
        "admin_*",
      ]);

      expect(lastLogLine()).toBe(`Updated MCP tool selection for "docs" in ${configPath}.`);

      mockLog.mockClear();
      await runMcpCommand(["mcp", "show", "docs", "--json"]);
      expect(JSON.parse(lastLogLine()).toolFilter).toEqual({
        include: ["read_*", "search"],
        exclude: ["admin_*"],
      });
    });
  });

  it("requires an explicit MCP tool filter operation", async () => {
    await withTempHome("openclaw-cli-mcp-home-", async () => {
      const workspaceDir = await createWorkspace();
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);

      await runMcpCommand(["mcp", "set", "docs", '{"command":"node","args":["server.mjs"]}']);
      await expect(runMcpCommand(["mcp", "tools", "docs"])).rejects.toThrow("__exit__:1");

      expect(lastErrorLine()).toBe("Specify --include, --exclude, or --clear.");
    });
  });

  it("clears per-server MCP tool filters only when requested", async () => {
    await withTempHome("openclaw-cli-mcp-home-", async () => {
      const workspaceDir = await createWorkspace();
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);

      await runMcpCommand(["mcp", "set", "docs", '{"command":"node","args":["server.mjs"]}']);
      await runMcpCommand(["mcp", "tools", "docs", "--include", "search"]);
      await runMcpCommand(["mcp", "tools", "docs", "--clear"]);

      mockLog.mockClear();
      await runMcpCommand(["mcp", "show", "docs", "--json"]);
      expect(JSON.parse(lastLogLine())).not.toHaveProperty("toolFilter");
    });
  });

  it("shows MCP transport status without connecting", async () => {
    await withTempHome("openclaw-cli-mcp-home-", async () => {
      const workspaceDir = await createWorkspace();
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);

      await runMcpCommand([
        "mcp",
        "set",
        "docs",
        '{"url":"https://mcp.example.com","transport":"streamable-http"}',
      ]);
      mockLog.mockClear();

      await runMcpCommand(["mcp", "status", "--json"]);

      expect(JSON.parse(lastLogLine()).servers).toEqual([
        {
          name: "docs",
          configured: true,
          enabled: true,
          ok: true,
          transport: "streamable-http",
          launch: "https://mcp.example.com",
          requestTimeoutMs: 60_000,
          connectionTimeoutMs: 30_000,
          supportsParallelToolCalls: false,
        },
      ]);
    });
  });

  it("includes OAuth credential status in MCP status output", async () => {
    await withTempHome("openclaw-cli-mcp-home-", async () => {
      const workspaceDir = await createWorkspace();
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);
      readMcpOAuthCredentialsStatus.mockResolvedValueOnce({
        hasTokens: true,
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
          hasClientInformation: true,
          hasCodeVerifier: false,
          hasDiscoveryState: true,
          hasLastAuthorizationUrl: true,
        },
      });
    });
  });

  it("configures enablement, timeouts, and OAuth login", async () => {
    await withTempHome("openclaw-cli-mcp-home-", async () => {
      const workspaceDir = await createWorkspace();
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);
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

      expect(runMcpOAuthLogin).toHaveBeenCalledWith({
        serverName: "docs",
        serverUrl: "https://mcp.example.com",
        config: undefined,
        fetchFn: expect.any(Function),
        authorizationCode: "abc123",
        onAuthorizationUrl: expect.any(Function),
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

  it("reports MCP doctor setup errors and sensitive literals", async () => {
    await withTempHome("openclaw-cli-mcp-home-", async () => {
      const workspaceDir = await createWorkspace();
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);

      await runMcpCommand([
        "mcp",
        "set",
        "docs",
        '{"command":"./missing-mcp","env":{"DOCS_API_KEY":"literal"},"headers":{"Authorization":"Bearer literal"}}',
      ]);
      mockLog.mockClear();

      await expect(runMcpCommand(["mcp", "doctor", "--json"])).rejects.toThrow("__exit__:1");

      const result = JSON.parse(lastLogLine());
      expect(result.ok).toBe(false);
      expect(lastErrorLine()).toBe("MCP doctor found errors.");
      expect(result.servers[0]).toMatchObject({ name: "docs", ok: false });
      expect(result.servers[0].issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            level: "error",
            message: "stdio command not found or not executable: ./missing-mcp",
          }),
          expect.objectContaining({
            level: "warning",
            message: expect.stringContaining("env.DOCS_API_KEY contains a literal sensitive value"),
          }),
          expect.objectContaining({
            level: "warning",
            message: expect.stringContaining(
              "headers.Authorization contains a literal sensitive value",
            ),
          }),
        ]),
      );
    });
  });

  it("does not fail MCP doctor for disabled-only overrides", async () => {
    await withTempHome("openclaw-cli-mcp-home-", async () => {
      const workspaceDir = await createWorkspace();
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);

      await runMcpCommand([
        "mcp",
        "set",
        "docs",
        '{"enabled":false,"env":{"DOCS_API_KEY":"literal"},"headers":{"Authorization":"Bearer literal"}}',
      ]);
      mockLog.mockClear();

      await runMcpCommand(["mcp", "doctor", "--json"]);

      expect(JSON.parse(lastLogLine())).toMatchObject({
        ok: true,
        servers: [
          {
            name: "docs",
            ok: true,
            issues: expect.arrayContaining([
              { level: "warning", message: "server is disabled" },
              expect.objectContaining({
                level: "warning",
                message: expect.stringContaining(
                  "env.DOCS_API_KEY contains a literal sensitive value",
                ),
              }),
              expect.objectContaining({
                level: "warning",
                message: expect.stringContaining(
                  "headers.Authorization contains a literal sensitive value",
                ),
              }),
            ]),
          },
        ],
      });
    });
  });

  it("uses configured PATH when checking MCP stdio commands", async () => {
    await withTempHome("openclaw-cli-mcp-home-", async () => {
      const workspaceDir = await createWorkspace();
      const binDir = path.join(workspaceDir, "bin");
      const commandPath = path.join(binDir, "docs-mcp");
      await fs.mkdir(binDir, { recursive: true });
      await fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n", "utf-8");
      await fs.chmod(commandPath, 0o755);
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);

      await runMcpCommand([
        "mcp",
        "set",
        "docs",
        JSON.stringify({ command: "docs-mcp", env: { PATH: binDir } }),
      ]);
      mockLog.mockClear();

      await runMcpCommand(["mcp", "doctor", "--json"]);

      expect(JSON.parse(lastLogLine())).toMatchObject({
        ok: true,
        servers: [{ name: "docs", ok: true, issues: [] }],
      });
    });
  });

  it("resolves relative configured PATH entries from the MCP stdio cwd", async () => {
    await withTempHome("openclaw-cli-mcp-home-", async () => {
      const workspaceDir = await createWorkspace();
      const appDir = path.join(workspaceDir, "app");
      const binDir = path.join(appDir, "node_modules", ".bin");
      const commandPath = path.join(binDir, "docs-mcp");
      await fs.mkdir(binDir, { recursive: true });
      await fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n", "utf-8");
      await fs.chmod(commandPath, 0o755);
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);

      await runMcpCommand([
        "mcp",
        "set",
        "docs",
        JSON.stringify({
          command: "docs-mcp",
          cwd: appDir,
          env: { PATH: "node_modules/.bin" },
        }),
      ]);
      mockLog.mockClear();

      await runMcpCommand(["mcp", "doctor", "--json"]);

      expect(JSON.parse(lastLogLine())).toMatchObject({
        ok: true,
        servers: [{ name: "docs", ok: true, issues: [] }],
      });
    });
  });

  it("clears stored OAuth credentials when auth is cleared", async () => {
    await withTempHome("openclaw-cli-mcp-home-", async () => {
      const workspaceDir = await createWorkspace();
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);

      await runMcpCommand([
        "mcp",
        "set",
        "docs",
        '{"url":"https://mcp.example.com","transport":"streamable-http","auth":"oauth"}',
      ]);
      await runMcpCommand(["mcp", "configure", "docs", "--clear-auth"]);

      expect(clearMcpOAuthCredentials).toHaveBeenCalledWith({
        serverName: "docs",
        serverUrl: "https://mcp.example.com",
      });

      mockLog.mockClear();
      await runMcpCommand(["mcp", "show", "docs", "--json"]);
      expect(JSON.parse(lastLogLine())).not.toHaveProperty("auth");
    });
  });

  it("clears stored OAuth credentials when an MCP server is removed", async () => {
    await withTempHome("openclaw-cli-mcp-home-", async () => {
      const workspaceDir = await createWorkspace();
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);

      await runMcpCommand([
        "mcp",
        "set",
        "docs",
        '{"url":"https://mcp.example.com","transport":"streamable-http","auth":"oauth"}',
      ]);
      await runMcpCommand(["mcp", "unset", "docs"]);

      expect(clearMcpOAuthCredentials).toHaveBeenCalledWith({
        serverName: "docs",
        serverUrl: "https://mcp.example.com",
      });
    });
  });

  it("clears stored OAuth credentials when set replaces an OAuth server", async () => {
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
      await runMcpCommand(["mcp", "set", "docs", '{"command":"uvx","args":["docs-mcp"]}']);

      expect(clearMcpOAuthCredentials).toHaveBeenCalledWith({
        serverName: "docs",
        serverUrl: "https://mcp.example.com",
      });
    });
  });

  it("clears stored OAuth credentials when add changes an OAuth server URL", async () => {
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
      await runMcpCommand([
        "mcp",
        "add",
        "docs",
        "--url",
        "https://other.example.com",
        "--transport",
        "streamable-http",
        "--auth",
        "oauth",
        "--no-probe",
      ]);

      expect(clearMcpOAuthCredentials).toHaveBeenCalledWith({
        serverName: "docs",
        serverUrl: "https://mcp.example.com",
      });
    });
  });

  it("clears timeout and parallel aliases when reconfiguring MCP servers", async () => {
    await withTempHome("openclaw-cli-mcp-home-", async () => {
      const workspaceDir = await createWorkspace();
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);

      await runMcpCommand([
        "mcp",
        "set",
        "docs",
        '{"url":"https://mcp.example.com","connect_timeout":7,"supports_parallel_tool_calls":true}',
      ]);
      await runMcpCommand(["mcp", "configure", "docs", "--clear-timeouts", "--no-parallel"]);

      mockLog.mockClear();
      await runMcpCommand(["mcp", "show", "docs", "--json"]);
      expect(JSON.parse(lastLogLine())).toEqual({
        url: "https://mcp.example.com",
      });
    });
  });

  it("removes pure disabled tombstones when enabling MCP servers", async () => {
    await withTempHome("openclaw-cli-mcp-home-", async () => {
      const workspaceDir = await createWorkspace();
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);

      await runMcpCommand(["mcp", "set", "bundleProbe", '{"enabled":false}']);
      await runMcpCommand(["mcp", "configure", "bundleProbe", "--enable"]);

      mockLog.mockClear();
      await runMcpCommand(["mcp", "list"]);
      expect(lastLogLine()).toContain("No MCP servers configured in ");
    });
  });

  it("fails named probes for disabled MCP servers", async () => {
    await withTempHome("openclaw-cli-mcp-home-", async (home) => {
      const workspaceDir = await createWorkspace();
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);

      await runMcpCommand(["mcp", "set", "docs", '{"enabled":false}']);

      await expect(runMcpCommand(["mcp", "probe", "docs"])).rejects.toThrow("__exit__:1");
      expect(lastErrorLine()).toBe(
        `MCP server "docs" is disabled in ${configPath}. Run openclaw mcp configure docs --enable before probing it.`,
      );
    });
  });

  it("fails when removing an unknown MCP server", async () => {
    await withTempHome("openclaw-cli-mcp-home-", async (home) => {
      const workspaceDir = await createWorkspace();
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);

      await expect(runMcpCommand(["mcp", "unset", "missing"])).rejects.toThrow("__exit__:1");
      expect(lastErrorLine()).toBe(
        `No MCP server named "missing" in ${configPath}. Run openclaw mcp list to see configured servers.`,
      );
    });
  });

  it("starts the channel bridge with parsed serve options", async () => {
    await withTempHome("openclaw-cli-mcp-home-", async () => {
      const workspaceDir = await createWorkspace();
      const tokenFile = path.join(workspaceDir, "gateway.token");
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);
      await fs.writeFile(tokenFile, "secret-token\n", "utf-8");

      await runMcpCommand([
        "mcp",
        "serve",
        "--url",
        "ws://127.0.0.1:18789",
        "--token-file",
        tokenFile,
        "--claude-channel-mode",
        "on",
        "--verbose",
      ]);

      expect(serveOpenClawChannelMcp).toHaveBeenCalledWith({
        gatewayUrl: "ws://127.0.0.1:18789",
        gatewayToken: "secret-token",
        gatewayPassword: undefined,
        claudeChannelMode: "on",
        verbose: true,
      });
    });
  });
});
