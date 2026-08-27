import { describe, expect, it, vi } from "vitest";
import { discoverOpenShellCapabilityRoots } from "./environment-capabilities.js";

describe("OpenShell environment capabilities", () => {
  it("returns a bounded remote MCP declaration", async () => {
    const contents = JSON.stringify({ mcpServers: { docs: { command: "docs-mcp" } } });
    const runCommand = vi.fn(async () => ({
      stdout: Buffer.from(`config\t${Buffer.from(contents).toString("base64")}\n`),
      stderr: Buffer.alloc(0),
      code: 0,
    }));

    await expect(
      discoverOpenShellCapabilityRoots({
        roots: [{ id: "workspace", path: "/sandbox" }],
        runCommand,
      }),
    ).resolves.toEqual([
      {
        id: "workspace",
        path: "/sandbox",
        mcpConfig: { path: "/sandbox/.mcp.json", contents },
      },
    ]);
  });
});
