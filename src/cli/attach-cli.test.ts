import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { writeClaudeMcpConfig } from "./attach-cli.js";

const MCP_CONFIG = {
  mcpServers: {
    openclaw: {
      type: "http",
      url: "http://127.0.0.1:54321/mcp",
      headers: {
        Authorization: "Bearer ${OPENCLAW_MCP_TOKEN}",
        "x-session-key": "${OPENCLAW_MCP_SESSION_KEY}",
      },
    },
  },
};

describe("writeClaudeMcpConfig", () => {
  it("writes the gateway mcpConfig verbatim to a .mcp.json (placeholders preserved for Claude env substitution)", () => {
    const { path, cleanup } = writeClaudeMcpConfig(MCP_CONFIG);
    try {
      expect(path.endsWith(".mcp.json")).toBe(true);
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(MCP_CONFIG);
    } finally {
      cleanup();
    }
  });

  it("cleanup removes the temp config", () => {
    const { path, cleanup } = writeClaudeMcpConfig(MCP_CONFIG);
    cleanup();
    expect(() => readFileSync(path, "utf8")).toThrow();
  });
});
