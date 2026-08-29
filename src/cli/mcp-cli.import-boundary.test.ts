import { Command } from "commander";
import { expect, it, vi } from "vitest";

vi.mock("../mcp/channel-server.js", () => {
  throw new Error("MCP client commands must not load the channel-serving runtime");
});

it("registers MCP commands and reloads client runtimes without channel serving", async () => {
  const { registerMcpCli } = await import("./mcp-cli.js");
  const program = new Command();
  program.exitOverride();
  registerMcpCli(program);

  await expect(program.parseAsync(["mcp", "reload"], { from: "user" })).resolves.toBe(program);
});
