import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTempHome } from "../config/home-env.test-harness.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  cleanupMcpCliTestState,
  createWorkspace,
  lastErrorLine,
  resetMcpCliTestState,
  runMcpCommand,
} from "./mcp-cli.test-harness.js";

describe("mcp cli mixed transports", () => {
  beforeEach(() => {
    resetMcpCliTestState();
  });

  afterEach(async () => {
    await cleanupMcpCliTestState();
  });

  it("rejects mixed command and URL transports before writing configuration", async () => {
    await withTempHome("openclaw-cli-mcp-home-", async (home) => {
      const workspaceDir = await createWorkspace();
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);

      try {
        await expect(
          runMcpCommand([
            "mcp",
            "set",
            "mixed",
            '{"command":"node","url":"https://mcp.example.com/mcp"}',
          ]),
        ).rejects.toThrow("__exit__:1");
        expect(lastErrorLine()).toContain('cannot define both a non-empty "command" and "url"');
        await expect(fs.readFile(configPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        closeOpenClawStateDatabaseForTest();
      }
    });
  });
});
