// MCP CLI JSON failure-envelope tests cover --json error output contracts.
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTempHome } from "../config/home-env.test-harness.js";
import {
  cleanupMcpCliTestState,
  createWorkspace,
  lastErrorLine,
  lastLogLine,
  mockError,
  mockLog,
  resetMcpCliTestState,
  runMcpCommand,
} from "./mcp-cli.test-harness.js";

describe("mcp cli --json failure envelope", () => {
  beforeEach(() => {
    resetMcpCliTestState();
  });

  afterEach(async () => {
    await cleanupMcpCliTestState();
  });

  it("prints a JSON failure envelope when show --json targets an unknown server", async () => {
    await withTempHome("openclaw-cli-mcp-home-", async (home) => {
      const workspaceDir = await createWorkspace();
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);

      mockLog.mockClear();
      await expect(runMcpCommand(["mcp", "show", "missing", "--json"])).rejects.toThrow(
        "__exit__:1",
      );
      expect(JSON.parse(lastLogLine())).toEqual({
        ok: false,
        error: {
          type: "cli_error",
          message: `No MCP server named "missing" in ${configPath}. Run openclaw mcp list to see configured servers.`,
        },
      });
      expect(mockError).not.toHaveBeenCalled();
    });
  });

  it("keeps the human stderr failure when show targets an unknown server without --json", async () => {
    await withTempHome("openclaw-cli-mcp-home-", async (home) => {
      const workspaceDir = await createWorkspace();
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);

      mockLog.mockClear();
      await expect(runMcpCommand(["mcp", "show", "missing"])).rejects.toThrow("__exit__:1");
      expect(lastErrorLine()).toBe(
        `No MCP server named "missing" in ${configPath}. Run openclaw mcp list to see configured servers.`,
      );
      expect(mockLog).not.toHaveBeenCalled();
    });
  });
});
