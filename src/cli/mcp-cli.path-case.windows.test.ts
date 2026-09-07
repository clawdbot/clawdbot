import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTempHome } from "../config/home-env.test-harness.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  cleanupMcpCliTestState,
  createWorkspace,
  lastLogLine,
  mockLog,
  resetMcpCliTestState,
  runMcpCommand,
} from "./mcp-cli.test-harness.js";

describe.runIf(process.platform === "win32")("MCP doctor Windows PATH casing", () => {
  beforeEach(() => {
    resetMcpCliTestState();
  });

  afterEach(async () => {
    await cleanupMcpCliTestState();
  });

  it("finds a real stdio command through an arbitrarily cased configured PATH", async () => {
    await withTempHome("openclaw-cli-mcp-path-case-home-", async () => {
      try {
        const workspaceDir = await createWorkspace();
        const binDir = path.join(workspaceDir, "Mixed Case Bin");
        await fs.mkdir(binDir, { recursive: true });
        await fs.writeFile(path.join(binDir, "DOCS-MCP.CMD"), "@echo off\r\nexit /b 0\r\n", "utf8");
        vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);

        await runMcpCommand([
          "mcp",
          "set",
          "docs",
          JSON.stringify({ command: "docs-mcp", env: { pAtH: binDir } }),
        ]);
        mockLog.mockClear();

        await runMcpCommand(["mcp", "doctor", "--json"]);

        expect(JSON.parse(lastLogLine())).toMatchObject({
          ok: true,
          servers: [{ name: "docs", ok: true, issues: [] }],
        });
      } finally {
        closeOpenClawStateDatabaseForTest();
      }
    });
  });
});
