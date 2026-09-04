import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withTempHome } from "../config/home-env.test-harness.js";
import {
  cleanupMcpCliTestState,
  lastLogLine,
  mockError,
  mockLog,
  resetMcpCliTestState,
  runMcpCommand,
} from "./mcp-cli.test-harness.js";

describe("mcp cli JSON failures", () => {
  beforeEach(() => {
    resetMcpCliTestState();
  });

  afterEach(async () => {
    await cleanupMcpCliTestState();
  });

  it.each(["show", "probe", "doctor"])(
    "emits one JSON failure for an unknown server in %s",
    async (command) => {
      await withTempHome("openclaw-cli-mcp-json-", async () => {
        await expect(runMcpCommand(["mcp", command, "missing", "--json"])).rejects.toThrow(
          "__exit__:1",
        );

        expect(mockLog).toHaveBeenCalledTimes(1);
        expect(mockError).not.toHaveBeenCalled();
        expect(JSON.parse(lastLogLine())).toMatchObject({
          ok: false,
          error: {
            type: "cli_error",
            message: expect.stringContaining('No MCP server named "missing"'),
          },
        });
      });
    },
  );

  it.each(["list", "show", "status", "probe", "doctor"])(
    "emits one JSON failure for invalid config in %s",
    async (command) => {
      await withTempHome("openclaw-cli-mcp-invalid-json-", async (home) => {
        await fs.writeFile(path.join(home, ".openclaw", "openclaw.json"), "{ invalid");
        await expect(runMcpCommand(["mcp", command, "--json"])).rejects.toThrow("__exit__:1");

        expect(mockLog).toHaveBeenCalledTimes(1);
        expect(JSON.parse(lastLogLine())).toEqual({
          ok: false,
          error: {
            type: "cli_error",
            message: "Config file is invalid; fix it before using MCP config commands.",
          },
        });
      });
    },
  );
});
