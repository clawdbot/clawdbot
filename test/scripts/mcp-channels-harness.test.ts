import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createMcpClientTempState } from "../../scripts/e2e/mcp-client-temp-state.js";

describe("mcp-channels harness", () => {
  it("creates unique client temp state and removes token files on cleanup", () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), "openclaw-mcp-harness-test-"));
    try {
      const first = createMcpClientTempState({ gatewayToken: "first-token", tempRoot });
      const second = createMcpClientTempState({ gatewayToken: "second-token", tempRoot });

      expect(first.root).not.toBe(second.root);
      expect(first.stateDir).toBe(path.join(first.root, "state"));
      expect(readFileSync(first.tokenFile, "utf8")).toBe("first-token\n");
      expect(statSync(first.tokenFile).mode & 0o777).toBe(0o600);
      expect(readFileSync(second.tokenFile, "utf8")).toBe("second-token\n");

      first.cleanup();
      second.cleanup();

      expect(existsSync(first.root)).toBe(false);
      expect(existsSync(second.root)).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("reuses one MCP temp state across the pairing reconnect path", () => {
    const source = readFileSync("scripts/e2e/mcp-channels-docker-client.ts", "utf8");

    expect(source).toContain("const mcpTempState = createMcpClientTempState({ gatewayToken });");
    expect(source.match(/tempState: mcpTempState/gu)).toHaveLength(2);
    expect(source).toContain("mcpTempState.cleanup();");
  });
});
