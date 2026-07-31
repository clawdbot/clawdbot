// MCP CLI tests cover MCP command registration and server configuration behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as mcpHttpFetch from "../agents/mcp-http-fetch.js";
import { withTempHome } from "../config/home-env.test-harness.js";
import { createDeferred } from "../shared/deferred.js";
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

async function writeProbeMcpServer(filePath: string): Promise<void> {
  await fs.writeFile(
    filePath,
    `let buffer = "";
const mode = process.env.MCP_MODE ?? "normal";
if (mode === "crash") {
  process.exit(1);
}
function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}
function handle(message) {
  if (message.method === "initialize") {
    if (mode === "hang-start") {
      return;
    }
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "cli-probe-test", version: "1.0.0" },
      },
    });
    return;
  }
  if (message.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { tools: [{ name: "ping", inputSchema: { type: "object" } }] },
    });
  }
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf("\\n");
    if (newline < 0) {
      return;
    }
    const line = buffer.slice(0, newline).replace(/\\r$/, "");
    buffer = buffer.slice(newline + 1);
    if (line.trim()) {
      handle(JSON.parse(line));
    }
  }
});
process.stdin.on("end", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
`,
    "utf8",
  );
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
      requiresAuthorization: false,
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
        requestTimeoutMs: 12_000,
        connectionTimeoutMs: 3_000,
        supportsParallelToolCalls: true,
      });
    });
  });

  it("rejects hexadecimal MCP timeout options before writing configuration", async () => {
    await withTempHome("openclaw-cli-mcp-home-", async (home) => {
      const workspaceDir = await createWorkspace();
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);

      await expect(
        runMcpCommand([
          "mcp",
          "add",
          "docs",
          "--url",
          "https://mcp.example.com/mcp",
          "--timeout",
          "0x10",
          "--no-probe",
        ]),
      ).rejects.toThrow("__exit__:1");
      expect(lastErrorLine()).toBe("--timeout must be a positive number.");
      await expect(fs.readFile(configPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

      await runMcpCommand([
        "mcp",
        "set",
        "docs",
        '{"url":"https://mcp.example.com","requestTimeoutMs":12000}',
      ]);
      mockError.mockClear();

      await expect(
        runMcpCommand(["mcp", "configure", "docs", "--connect-timeout", "0x3"]),
      ).rejects.toThrow("__exit__:1");
      expect(lastErrorLine()).toBe("--connect-timeout must be a positive number.");

      mockLog.mockClear();
      await runMcpCommand(["mcp", "show", "docs", "--json"]);
      expect(JSON.parse(lastLogLine())).toEqual({
        url: "https://mcp.example.com",
        requestTimeoutMs: 12_000,
      });
    });
  });

  it(
    "requires initialize to finish within the configured probe timeout before saving",
    { timeout: 10_000 },
    async () => {
      await withTempHome("openclaw-cli-mcp-home-", async (home) => {
        const workspaceDir = await createWorkspace();
        const serverPath = path.join(workspaceDir, "probe-server.mjs");
        const configPath = path.join(home, ".openclaw", "openclaw.json");
        await writeProbeMcpServer(serverPath);
        vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);

        const startedAt = performance.now();
        await expect(
          runMcpCommand([
            "mcp",
            "add",
            "hung",
            "--command",
            process.execPath,
            "--arg",
            serverPath,
            "--env",
            "MCP_MODE=hang-start",
            "--connect-timeout",
            "0.2",
          ]),
        ).rejects.toThrow("__exit__:1");
        const elapsedMs = performance.now() - startedAt;

        expect(elapsedMs).toBeGreaterThanOrEqual(100);
        expect(elapsedMs).toBeLessThan(1_500);
        expect(lastErrorLine()).toContain(
          'MCP server "hung" timed out: did not complete initialize within 0.2s',
        );
        await expect(fs.readFile(configPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

        await runMcpCommand([
          "mcp",
          "add",
          "ok",
          "--command",
          process.execPath,
          "--arg",
          serverPath,
          "--env",
          "MCP_MODE=normal",
        ]);
        expect(lastLogLine()).toBe(`Saved MCP server "ok" to ${configPath}.`);

        await expect(
          runMcpCommand([
            "mcp",
            "add",
            "crash",
            "--command",
            process.execPath,
            "--arg",
            serverPath,
            "--env",
            "MCP_MODE=crash",
          ]),
        ).rejects.toThrow("__exit__:1");

        mockLog.mockClear();
        await runMcpCommand(["mcp", "list", "--json"]);
        const saved = JSON.parse(lastLogLine()) as Record<string, unknown>;
        expect(Object.keys(saved)).toEqual(["ok"]);
      });
    },
  );

  it(
    "bounds initialize with a five-second probe timeout when no flag is supplied",
    { timeout: 8_000 },
    async () => {
      await withTempHome("openclaw-cli-mcp-home-", async (home) => {
        const workspaceDir = await createWorkspace();
        const serverPath = path.join(workspaceDir, "probe-server.mjs");
        const configPath = path.join(home, ".openclaw", "openclaw.json");
        await writeProbeMcpServer(serverPath);
        vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);

        const startedAt = performance.now();
        await expect(
          runMcpCommand([
            "mcp",
            "add",
            "hung-default",
            "--command",
            process.execPath,
            "--arg",
            serverPath,
            "--env",
            "MCP_MODE=hang-start",
          ]),
        ).rejects.toThrow("__exit__:1");
        const elapsedMs = performance.now() - startedAt;

        expect(elapsedMs).toBeGreaterThanOrEqual(4_500);
        expect(elapsedMs).toBeLessThan(6_500);
        expect(lastErrorLine()).toContain(
          'MCP server "hung-default" timed out: did not complete initialize within 5s',
        );
        await expect(fs.readFile(configPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      });
    },
  );

  it("labels listed MCP servers as OpenClaw-managed", async () => {
    await withTempHome("openclaw-cli-mcp-home-", async () => {
      const workspaceDir = await createWorkspace();
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);

      await runMcpCommand(["mcp", "set", "context7", '{"command":"uvx","args":["context7-mcp"]}']);
      mockLog.mockClear();

      await runMcpCommand(["mcp", "list"]);

      const output = mockLog.mock.calls.map((call) => String(call[0])).join("\n");
      expect(output).toContain("OpenClaw-managed MCP servers (");
      expect(output).toContain("- context7");
      expect(output).toContain("OpenClaw-managed mcp.servers entries");
      expect(output).toContain("does not include mcporter servers from config/mcporter.json");
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

  it("redacts stdio argv credentials from MCP status output", async () => {
    await withTempHome("openclaw-cli-mcp-home-", async () => {
      const workspaceDir = await createWorkspace();
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);

      await runMcpCommand([
        "mcp",
        "set",
        "local",
        '{"command":"node","args":["server.mjs","--api-key","test-api-key","--token=test-token"]}',
      ]);
      mockLog.mockClear();

      await runMcpCommand(["mcp", "status", "--json"]);
      const jsonOutput = lastLogLine();
      expect(jsonOutput).not.toContain("test-api-key");
      expect(jsonOutput).not.toContain("test-token");
      expect(JSON.parse(jsonOutput).servers[0].launch).toBe(
        "node server.mjs --api-key *** --token=***",
      );

      mockLog.mockClear();
      await runMcpCommand(["mcp", "status", "--verbose"]);
      const verboseOutput = mockLog.mock.calls.map(([line]) => String(line)).join("\n");
      expect(verboseOutput).toContain("launch: node server.mjs --api-key *** --token=***");
      expect(verboseOutput).not.toContain("test-api-key");
      expect(verboseOutput).not.toContain("test-token");
    });
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

  it("bounds concurrent MCP doctor server checks", async () => {
    await withTempHome("openclaw-cli-mcp-home-", async () => {
      const workspaceDir = await createWorkspace();
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);
      for (let index = 0; index < 6; index += 1) {
        await runMcpCommand([
          "mcp",
          "set",
          `server-${index}`,
          JSON.stringify({
            url: `https://mcp-${index}.example.com`,
            transport: "streamable-http",
            auth: "oauth",
          }),
        ]);
      }

      const checksBlocked = createDeferred();
      readMcpOAuthCredentialsStatus.mockImplementation(async () => {
        await checksBlocked.promise;
        return {
          hasTokens: false,
          hasClientInformation: false,
          hasCodeVerifier: false,
          hasDiscoveryState: false,
          hasLastAuthorizationUrl: false,
        };
      });

      const doctorPromise = runMcpCommand(["mcp", "doctor", "--json"]);
      await vi.waitFor(() => {
        expect(readMcpOAuthCredentialsStatus.mock.calls.length).toBeGreaterThanOrEqual(4);
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      const startedBeforeRelease = readMcpOAuthCredentialsStatus.mock.calls.length;
      checksBlocked.resolve();
      await doctorPromise;

      expect(readMcpOAuthCredentialsStatus).toHaveBeenCalledTimes(6);
      expect(startedBeforeRelease).toBe(4);
      expect(
        JSON.parse(lastLogLine()).servers.map((server: { name: string }) => server.name),
      ).toEqual(["server-0", "server-1", "server-2", "server-3", "server-4", "server-5"]);
    });
  });

  it("surfaces unexpected MCP doctor check errors", async () => {
    await withTempHome("openclaw-cli-mcp-home-", async () => {
      const workspaceDir = await createWorkspace();
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);
      await runMcpCommand([
        "mcp",
        "set",
        "docs",
        '{"url":"https://mcp.example.com","transport":"streamable-http","auth":"oauth"}',
      ]);
      readMcpOAuthCredentialsStatus.mockRejectedValueOnce(new Error("credential store failed"));

      await expect(runMcpCommand(["mcp", "doctor", "--json"])).rejects.toThrow(
        "credential store failed",
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

  it("removes pure disabled tombstones when enabling MCP servers", async () => {
    await withTempHome("openclaw-cli-mcp-home-", async () => {
      const workspaceDir = await createWorkspace();
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);

      await runMcpCommand(["mcp", "set", "bundleProbe", '{"enabled":false}']);
      await runMcpCommand(["mcp", "configure", "bundleProbe", "--enable"]);

      mockLog.mockClear();
      await runMcpCommand(["mcp", "list"]);
      const output = mockLog.mock.calls.map((call) => String(call[0])).join("\n");
      expect(output).toContain("No OpenClaw-managed MCP servers configured in ");
      expect(output).toContain("does not include mcporter servers from config/mcporter.json");
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
