// Codex session CLI tests cover passive catalog output and local supervision actions.
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerCodexSessionCli } from "./session-cli.js";

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
      error: { code: "NODE_OFFLINE", message: "Paired node is offline" },
    },
  ],
};

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  registerCodexSessionCli(program);
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

describe("registerCodexSessionCli", () => {
  beforeEach(() => {
    gatewayRuntime.callGatewayFromCli.mockReset();
    gatewayRuntime.callGatewayFromCli.mockResolvedValue(catalog);
  });

  describe("sessions", () => {
    it("maps non-archived filters and a host cursor to the catalog Gateway method", async () => {
      const program = createProgram();
      const output = await captureStdout(async () => {
        await program.parseAsync(
          [
            "codex",
            "sessions",
            "--search",
            "  openclaw  ",
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
        "codex.sessions.list",
        {
          url: "ws://gateway.test",
          token: "secret",
          timeout: "1234",
          json: true,
        },
        {
          search: "openclaw",
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
      expect(output).toContain("source vscode");
      expect(output).toContain("provider openai");
      expect(output).toContain(
        "repeat the same filters with --host 'gateway:local' --cursor 'gateway-next'",
      );
      expect(output).toContain("Dev Box (node · node:devbox · devbox) — offline — 0 sessions");
      expect(output).toContain("Error [NODE_OFFLINE]: Paired node is offline");
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
      expect(output).toContain("Error [CATALOG_FAILED]: Codex session catalog request failed");
    });

    it("reports empty catalog and unmatched host results", async () => {
      gatewayRuntime.callGatewayFromCli.mockResolvedValue({ hosts: [] });

      const emptyOutput = await captureStdout(async () => {
        await createProgram().parseAsync(["codex", "sessions"], { from: "user" });
      });
      const hostOutput = await captureStdout(async () => {
        await createProgram().parseAsync(["codex", "sessions", "--host", "node:missing"], {
          from: "user",
        });
      });

      expect(emptyOutput).toBe("No Codex session hosts found.\n");
      expect(hostOutput).toBe('No Codex session host matched "node:missing".\n');
    });

    it("rejects an archived-session filter and unroutable cursor before calling the Gateway", async () => {
      await expect(
        createProgram().parseAsync(["codex", "sessions", "--archived"], { from: "user" }),
      ).rejects.toThrow("unknown option '--archived'");
      await expect(
        createProgram().parseAsync(["codex", "sessions", "--cursor", "next"], { from: "user" }),
      ).rejects.toThrow("--cursor requires --host");

      expect(gatewayRuntime.callGatewayFromCli).not.toHaveBeenCalled();
    });

    it("rejects invalid per-host limits before calling the Gateway", async () => {
      await expect(
        createProgram().parseAsync(["codex", "sessions", "--limit", "1.5"], { from: "user" }),
      ).rejects.toThrow("--limit must be an integer between 1 and 100");
      await expect(
        createProgram().parseAsync(["codex", "sessions", "--limit", "101"], { from: "user" }),
      ).rejects.toThrow("--limit must be an integer between 1 and 100");

      expect(gatewayRuntime.callGatewayFromCli).not.toHaveBeenCalled();
    });

    it("rejects malformed catalog responses", async () => {
      gatewayRuntime.callGatewayFromCli.mockResolvedValueOnce({ hosts: null });

      await expect(
        createProgram().parseAsync(["codex", "sessions"], { from: "user" }),
      ).rejects.toThrow("Codex session catalog returned an invalid result");
    });

    it("rejects archived sessions from a catalog response", async () => {
      gatewayRuntime.callGatewayFromCli.mockResolvedValueOnce({
        hosts: [
          {
            hostId: "gateway:local",
            label: "Local Codex",
            kind: "gateway",
            connected: true,
            sessions: [{ threadId: "archived-thread", status: "notLoaded", archived: true }],
          },
        ],
      });

      await expect(
        createProgram().parseAsync(["codex", "sessions"], { from: "user" }),
      ).rejects.toThrow("Codex session catalog returned an invalid session");
    });
  });

  describe("continue", () => {
    it("continues a Gateway-local thread and sanitizes the human-readable session key", async () => {
      gatewayRuntime.callGatewayFromCli.mockResolvedValueOnce({
        sessionKey: "harness:codex:supervision:branch\u001b[2J",
        disposition: "forked",
      });

      const output = await captureStdout(async () => {
        await createProgram().parseAsync(
          [
            "codex",
            "continue",
            "thread-1",
            "--url",
            "ws://gateway.test",
            "--token",
            "secret",
            "--timeout",
            "4321",
          ],
          { from: "user" },
        );
      });

      expect(gatewayRuntime.callGatewayFromCli).toHaveBeenCalledWith(
        "codex.sessions.continue",
        {
          url: "ws://gateway.test",
          token: "secret",
          timeout: "4321",
          json: false,
        },
        { hostId: "gateway:local", threadId: "thread-1" },
        { mode: "cli", scopes: ["operator.write"] },
      );
      expect(output).toBe("OpenClaw session (branch created): harness:codex:supervision:branch\n");
      expect(output).not.toContain("\u001b");
    });

    it("prints existing session results as JSON", async () => {
      gatewayRuntime.callGatewayFromCli.mockResolvedValueOnce({
        sessionKey: "harness:codex:supervision:existing",
        disposition: "existing",
        ignored: true,
      });

      const output = await captureStdout(async () => {
        await createProgram().parseAsync(["codex", "continue", "thread-2", "--json"], {
          from: "user",
        });
      });

      expect(JSON.parse(output)).toEqual({
        sessionKey: "harness:codex:supervision:existing",
        disposition: "existing",
      });
    });

    it.each([
      [{ disposition: "forked" }, "invalid session key"],
      [{ sessionKey: " ", disposition: "forked" }, "invalid session key"],
      [{ sessionKey: "session", disposition: "new" }, "invalid disposition"],
    ])("rejects invalid Gateway results %#", async (result, message) => {
      gatewayRuntime.callGatewayFromCli.mockResolvedValueOnce(result);

      await expect(
        createProgram().parseAsync(["codex", "continue", "thread-1"], { from: "user" }),
      ).rejects.toThrow(message);
    });

    it("rejects an empty thread id before calling the Gateway", async () => {
      await expect(
        createProgram().parseAsync(["codex", "continue", "   "], { from: "user" }),
      ).rejects.toThrow("Codex thread id must not be empty");

      expect(gatewayRuntime.callGatewayFromCli).not.toHaveBeenCalled();
    });
  });

  describe("archive", () => {
    it("requires explicit confirmation before calling the Gateway", async () => {
      await expect(
        createProgram().parseAsync(["codex", "archive", "thread-1"], { from: "user" }),
      ).rejects.toThrow("--confirm-no-other-runner is required");

      expect(gatewayRuntime.callGatewayFromCli).not.toHaveBeenCalled();
    });

    it("archives a Gateway-local thread and prints the structured result as JSON", async () => {
      gatewayRuntime.callGatewayFromCli.mockResolvedValueOnce({ archived: true, ignored: true });

      const output = await captureStdout(async () => {
        await createProgram().parseAsync(
          [
            "codex",
            "archive",
            "thread-1",
            "--confirm-no-other-runner",
            "--json",
            "--url",
            "ws://gateway.test",
          ],
          { from: "user" },
        );
      });

      expect(gatewayRuntime.callGatewayFromCli).toHaveBeenCalledWith(
        "codex.sessions.archive",
        { url: "ws://gateway.test", timeout: "30000", json: true },
        { hostId: "gateway:local", threadId: "thread-1", confirmNoOtherRunner: true },
        { mode: "cli", scopes: ["operator.write"] },
      );
      expect(JSON.parse(output)).toEqual({ archived: true });
    });

    it("renders a successful archive in human-readable output", async () => {
      gatewayRuntime.callGatewayFromCli.mockResolvedValueOnce({ archived: true });

      const output = await captureStdout(async () => {
        await createProgram().parseAsync(
          ["codex", "archive", "thread-2", "--confirm-no-other-runner"],
          { from: "user" },
        );
      });

      expect(output).toBe("Archived Codex thread thread-2.\n");
    });

    it("rejects an invalid Gateway result", async () => {
      gatewayRuntime.callGatewayFromCli.mockResolvedValueOnce({ archived: false });

      await expect(
        createProgram().parseAsync(["codex", "archive", "thread-1", "--confirm-no-other-runner"], {
          from: "user",
        }),
      ).rejects.toThrow("Codex session archive returned an invalid result");
    });

    it("rejects an empty thread id before checking confirmation or calling the Gateway", async () => {
      await expect(
        createProgram().parseAsync(["codex", "archive", "   ", "--confirm-no-other-runner"], {
          from: "user",
        }),
      ).rejects.toThrow("Codex thread id must not be empty");

      expect(gatewayRuntime.callGatewayFromCli).not.toHaveBeenCalled();
    });
  });
});
