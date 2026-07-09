// Codex Supervisor tests cover CLI catalog filters, output, and Gateway authorization.
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerCodexSupervisorCli } from "./cli.js";

const gatewayRuntime = vi.hoisted(() => ({
  callGatewayFromCli: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/gateway-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/gateway-runtime")>(
    "openclaw/plugin-sdk/gateway-runtime",
  );
  return {
    ...actual,
    callGatewayFromCli: gatewayRuntime.callGatewayFromCli,
  };
});

const catalog = {
  hosts: [
    {
      hostId: "gateway:local",
      label: "MacBook Pro",
      kind: "gateway",
      connected: true,
      endpointId: "local",
      sessions: [
        {
          threadId: "00000000-0000-4000-8000-000000000002",
          name: "Build Codex fleet sessions",
          cwd: "/Users/test/Projects/openclaw",
          status: "idle",
          activeFlags: [],
          updatedAt: 1_788_805_800,
          recencyAt: 1_788_805_800,
          source: "vscode",
          modelProvider: "openai",
          gitBranch: "codex/codex-session-fleet",
          archived: false,
        },
      ],
      nextCursor: "gateway-next",
    },
    {
      hostId: "node:devbox",
      label: "Dev Box",
      kind: "node",
      connected: false,
      nodeId: "devbox",
      sessions: [],
      error: { code: "NODE_OFFLINE", message: "node is not connected" },
    },
  ],
};

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  registerCodexSupervisorCli(program);
  return program;
}

async function captureStdout(run: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk): boolean => {
    chunks.push(String(chunk));
    return true;
  });
  try {
    await run();
    return chunks.join("");
  } finally {
    write.mockRestore();
  }
}

describe("registerCodexSupervisorCli", () => {
  beforeEach(() => {
    gatewayRuntime.callGatewayFromCli.mockReset();
    gatewayRuntime.callGatewayFromCli.mockResolvedValue(catalog);
  });

  it("maps filters and a host cursor to the catalog Gateway method", async () => {
    const program = createProgram();
    const output = await captureStdout(async () => {
      await program.parseAsync(
        [
          "codex",
          "sessions",
          "--search",
          "  openclaw  ",
          "--archived",
          "--host",
          "node:devbox",
          "--limit",
          "25",
          "--cursor",
          "node-next",
          "--url",
          "ws://gateway.test",
          "--token",
          "secret",
          "--timeout",
          "1234",
          "--json",
        ],
        { from: "user" },
      );
    });

    expect(gatewayRuntime.callGatewayFromCli).toHaveBeenCalledWith(
      "codex-supervisor.sessions.list",
      {
        url: "ws://gateway.test",
        token: "secret",
        timeout: "1234",
        json: true,
      },
      {
        search: "openclaw",
        archived: true,
        limitPerHost: 25,
        hostIds: ["node:devbox"],
        cursors: { "node:devbox": "node-next" },
      },
      { mode: "cli", scopes: ["operator.write"] },
    );
    expect(JSON.parse(output)).toEqual({ hosts: [catalog.hosts[1]] });
  });

  it("renders connected sessions, metadata, pagination, and offline host errors", async () => {
    const program = createProgram();
    const output = await captureStdout(async () => {
      await program.parseAsync(["codex", "sessions"], { from: "user" });
    });

    expect(output).toContain("MacBook Pro (gateway · gateway:local) — connected — 1 session");
    expect(output).toContain("00000000-0000-4000-8000-000000000002");
    expect(output).toContain("Build Codex fleet sessions");
    expect(output).toContain("/Users/test/Projects/openclaw");
    expect(output).toContain("branch codex/codex-session-fleet");
    expect(output).toContain(
      "repeat the same filters with --host 'gateway:local' --cursor 'gateway-next'",
    );
    expect(output).toContain("Dev Box (node · node:devbox · devbox) — offline — 0 sessions");
    expect(output).toContain("Error [NODE_OFFLINE]: node is not connected");
  });

  it("neutralizes terminal controls in human-readable host and session metadata", async () => {
    const program = createProgram();
    gatewayRuntime.callGatewayFromCli.mockResolvedValueOnce({
      hosts: [
        {
          hostId: "gateway:local\u001b",
          label: "Mac\u001b[31m\nBook",
          kind: "gateway",
          connected: true,
          sessions: [
            {
              threadId: "thread\u001b[2J",
              name: "Fleet\u0007\nSession",
              cwd: "/tmp/work\u001b]0;owned\u0007",
              status: "idle\u001b",
              activeFlags: ["turn\u001b"],
              gitBranch: "main\u0000branch",
              archived: false,
            },
          ],
          error: { code: "WARN\u001b", message: "first\nsecond\u0007" },
          nextCursor: "next\u001b[2J",
        },
      ],
    });

    const output = await captureStdout(async () => {
      await program.parseAsync(["codex", "sessions"], { from: "user" });
    });

    expect(output).not.toContain("\u001b");
    expect(output).not.toContain("\u0007");
    expect(output).not.toContain("\u0000");
    expect(output).toContain("Fleet\\nSession");
    expect(output).toContain("mainbranch");
    expect(output).toContain("first\\nsecond");
  });

  it("rejects an unroutable cursor before calling the Gateway", async () => {
    const program = createProgram();

    await expect(
      program.parseAsync(["codex", "sessions", "--cursor", "next"], { from: "user" }),
    ).rejects.toThrow("--cursor requires --host");
    expect(gatewayRuntime.callGatewayFromCli).not.toHaveBeenCalled();
  });

  it("rejects invalid per-host limits before calling the Gateway", async () => {
    const program = createProgram();

    await expect(
      program.parseAsync(["codex", "sessions", "--limit", "1.5"], { from: "user" }),
    ).rejects.toThrow("--limit must be an integer between 1 and 100");
    await expect(
      program.parseAsync(["codex", "sessions", "--limit", "101"], { from: "user" }),
    ).rejects.toThrow("--limit must be an integer between 1 and 100");
    expect(gatewayRuntime.callGatewayFromCli).not.toHaveBeenCalled();
  });

  it("rejects malformed catalog responses", async () => {
    const program = createProgram();
    gatewayRuntime.callGatewayFromCli.mockResolvedValueOnce({ hosts: null });

    await expect(program.parseAsync(["codex", "sessions"], { from: "user" })).rejects.toThrow(
      "Codex session catalog returned an invalid result",
    );
  });
});
