// MCP CLI `call` tests stay separate so mcp-cli.test.ts stays under max-lines.
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
    clearMcpOAuthCredentials: vi.fn(),
    readMcpOAuthCredentialsStatus: vi.fn(),
    runMcpOAuthLogin: vi.fn(),
    requestExitAfterOneShotOutput: vi.fn(() => true),
  };
});

const defaultRuntime = mocks.runtime;
const mockLog = defaultRuntime.log;
const mockError = defaultRuntime.error;
const readMcpOAuthCredentialsStatus = mocks.readMcpOAuthCredentialsStatus;
const requestExitAfterOneShotOutput = mocks.requestExitAfterOneShotOutput;

vi.mock("../runtime.js", () => ({
  defaultRuntime: mocks.runtime,
}));

// Post-connect failures hand their exit code to the shared finalizer instead of
// calling process.exit() inline, so assert the request rather than a throw.
vi.mock("./one-shot-exit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./one-shot-exit.js")>()),
  requestExitAfterOneShotOutput: mocks.requestExitAfterOneShotOutput,
}));

vi.mock("../mcp/channel-server.js", () => ({
  serveOpenClawChannelMcp: vi.fn(),
}));

vi.mock("../agents/mcp-oauth.js", () => ({
  clearMcpOAuthCredentials: mocks.clearMcpOAuthCredentials,
  readMcpOAuthCredentialsStatus: mocks.readMcpOAuthCredentialsStatus,
  runMcpOAuthLogin: mocks.runMcpOAuthLogin,
}));

const tempDirs: string[] = [];

async function createWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-mcp-call-"));
  tempDirs.push(dir);
  return dir;
}

async function writeCallMcpServer(filePath: string): Promise<void> {
  await fs.writeFile(
    filePath,
    `let buffer = "";
function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}
function handle(message) {
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "cli-call-test", version: "1.0.0" },
      },
    });
    return;
  }
  if (message.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [
          { name: "ping", inputSchema: { type: "object" } },
          { name: "echo", inputSchema: { type: "object" } },
        ],
      },
    });
    return;
  }
  if (message.method === "tools/call") {
    const isError = process.env.MCP_TOOL_ERROR === "1";
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        isError,
        content: [
          {
            type: "text",
            text: isError
              ? "tool failed"
              : JSON.stringify({
                  tool: message.params?.name ?? null,
                  arguments: message.params?.arguments ?? {},
                }),
          },
        ],
      },
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

function lastRuntimeLine(mock: typeof mockLog): string {
  const call = mock.mock.calls[mock.mock.calls.length - 1];
  return String(call?.[0] ?? "");
}

function lastLogLine(): string {
  return lastRuntimeLine(mockLog);
}

function lastErrorLine(): string {
  return lastRuntimeLine(mockError);
}

describe("mcp cli call", () => {
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

  it("calls a configured MCP tool with default empty object input", async () => {
    await withTempHome("openclaw-cli-mcp-call-home-", async () => {
      const workspaceDir = await createWorkspace();
      const serverPath = path.join(workspaceDir, "call-server.mjs");
      await writeCallMcpServer(serverPath);
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);

      await runMcpCommand([
        "mcp",
        "set",
        "docs",
        JSON.stringify({ command: process.execPath, args: [serverPath] }),
      ]);
      mockLog.mockClear();

      await runMcpCommand(["mcp", "call", "docs", "ping"]);

      expect(JSON.parse(lastLogLine())).toMatchObject({
        isError: false,
        content: [
          {
            type: "text",
            text: JSON.stringify({ tool: "ping", arguments: {} }),
          },
        ],
      });
    });
  });

  it("calls a configured MCP tool with inline and file JSON input", async () => {
    await withTempHome("openclaw-cli-mcp-call-home-", async () => {
      const workspaceDir = await createWorkspace();
      const serverPath = path.join(workspaceDir, "call-server.mjs");
      const inputPath = path.join(workspaceDir, "input.json");
      await writeCallMcpServer(serverPath);
      await fs.writeFile(inputPath, '{"q":"file"}', "utf8");
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);

      await runMcpCommand([
        "mcp",
        "set",
        "docs",
        JSON.stringify({ command: process.execPath, args: [serverPath] }),
      ]);

      mockLog.mockClear();
      await runMcpCommand(["mcp", "call", "docs", "echo", "--input", '{"q":"inline"}']);
      expect(JSON.parse(lastLogLine())).toMatchObject({
        content: [
          {
            type: "text",
            text: JSON.stringify({ tool: "echo", arguments: { q: "inline" } }),
          },
        ],
      });

      mockLog.mockClear();
      await runMcpCommand(["mcp", "call", "docs", "echo", "--input-file", inputPath]);
      expect(JSON.parse(lastLogLine())).toMatchObject({
        content: [
          {
            type: "text",
            text: JSON.stringify({ tool: "echo", arguments: { q: "file" } }),
          },
        ],
      });
    });
  });

  it("rejects invalid call input and conflicting flags before connecting", async () => {
    await withTempHome("openclaw-cli-mcp-call-home-", async () => {
      const workspaceDir = await createWorkspace();
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);

      await expect(
        runMcpCommand(["mcp", "call", "docs", "ping", "--input", "[1]", "--input-file", "-"]),
      ).rejects.toThrow("__exit__:1");
      expect(lastErrorLine()).toBe("Specify only one of --input or --input-file.");

      mockError.mockClear();
      await expect(
        runMcpCommand(["mcp", "call", "docs", "ping", "--input", "[1]"]),
      ).rejects.toThrow("__exit__:1");
      expect(lastErrorLine()).toBe("--input must be a JSON object, not an array or scalar.");

      mockError.mockClear();
      await expect(
        runMcpCommand(["mcp", "call", "docs", "ping", "--input", '"scalar"']),
      ).rejects.toThrow("__exit__:1");
      expect(lastErrorLine()).toBe("--input must be a JSON object, not an array or scalar.");
    });
  });

  it("rejects unknown, disabled, and filtered MCP tools without invoking them", async () => {
    await withTempHome("openclaw-cli-mcp-call-home-", async (home) => {
      const workspaceDir = await createWorkspace();
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const serverPath = path.join(workspaceDir, "call-server.mjs");
      await writeCallMcpServer(serverPath);
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);

      await expect(runMcpCommand(["mcp", "call", "missing", "ping"])).rejects.toThrow("__exit__:1");
      expect(lastErrorLine()).toContain(`No MCP server named "missing" in ${configPath}`);

      await runMcpCommand([
        "mcp",
        "set",
        "docs",
        JSON.stringify({
          command: process.execPath,
          args: [serverPath],
          enabled: false,
        }),
      ]);
      await expect(runMcpCommand(["mcp", "call", "docs", "ping"])).rejects.toThrow("__exit__:1");
      expect(lastErrorLine()).toContain(`MCP server "docs" is disabled in ${configPath}`);

      await runMcpCommand([
        "mcp",
        "set",
        "docs",
        JSON.stringify({
          command: process.execPath,
          args: [serverPath],
          toolFilter: { include: ["echo"] },
        }),
      ]);
      await runMcpCommand(["mcp", "call", "docs", "ping"]);
      expect(requestExitAfterOneShotOutput).toHaveBeenCalledWith(defaultRuntime, 1);
      expect(lastErrorLine()).toContain(
        `MCP tool "ping" is unavailable on server "docs" (unknown, filtered, or not advertised)`,
      );
      expect(lastErrorLine()).toContain("Available tools: echo");
    });
  });

  it("prints structured MCP tool errors and exits non-zero", async () => {
    await withTempHome("openclaw-cli-mcp-call-home-", async () => {
      const workspaceDir = await createWorkspace();
      const serverPath = path.join(workspaceDir, "call-server.mjs");
      await writeCallMcpServer(serverPath);
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);

      await runMcpCommand([
        "mcp",
        "set",
        "docs",
        JSON.stringify({
          command: process.execPath,
          args: [serverPath],
          env: { MCP_TOOL_ERROR: "1" },
        }),
      ]);
      mockLog.mockClear();

      await runMcpCommand(["mcp", "call", "docs", "ping"]);
      expect(JSON.parse(lastLogLine())).toMatchObject({
        isError: true,
        content: [{ type: "text", text: "tool failed" }],
      });
      expect(lastErrorLine()).toBe(`MCP tool "ping" on server "docs" returned isError=true.`);
      // The exit is deferred so the finalizer can drain stdout first.
      expect(defaultRuntime.exit).not.toHaveBeenCalled();
      expect(requestExitAfterOneShotOutput).toHaveBeenCalledWith(defaultRuntime, 1);
    });
  });

  it("requires OAuth login before calling an unauthorized OAuth MCP server", async () => {
    await withTempHome("openclaw-cli-mcp-call-home-", async () => {
      const workspaceDir = await createWorkspace();
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);
      readMcpOAuthCredentialsStatus.mockResolvedValue({
        hasTokens: false,
        requiresAuthorization: false,
        hasClientInformation: false,
        hasCodeVerifier: false,
        hasDiscoveryState: false,
        hasLastAuthorizationUrl: false,
      });

      await runMcpCommand([
        "mcp",
        "set",
        "docs",
        '{"url":"https://mcp.example.com","transport":"streamable-http","auth":"oauth"}',
      ]);

      await expect(runMcpCommand(["mcp", "call", "docs", "ping"])).rejects.toThrow("__exit__:1");
      expect(lastErrorLine()).toContain(
        `MCP server "docs" requires OAuth authorization. Run openclaw mcp login docs`,
      );
    });
  });
});
