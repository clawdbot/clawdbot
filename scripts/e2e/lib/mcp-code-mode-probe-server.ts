// MCP code-mode probe server fixture shared by local and Docker E2E scripts.
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

export async function writeProbeMcpServer(serverPath: string) {
  const sdkMcpServerPath = require.resolve("@modelcontextprotocol/sdk/server/mcp.js");
  const sdkStdioServerPath = require.resolve("@modelcontextprotocol/sdk/server/stdio.js");
  const zodPath = require.resolve("zod");
  await fs.mkdir(path.dirname(serverPath), { recursive: true });
  await fs.writeFile(
    serverPath,
    `#!/usr/bin/env node
import { McpServer } from ${JSON.stringify(sdkMcpServerPath)};
import { StdioServerTransport } from ${JSON.stringify(sdkStdioServerPath)};
import { z } from ${JSON.stringify(zodPath)};

const notes = new Map([
  ["alpha", "fixture-note-alpha"],
  ["beta", "fixture-note-beta"],
]);
const server = new McpServer({ name: "code-mode-fixture", version: "1.0.0" });

server.tool(
  "lookup_note",
  "Look up one read-only fixture note by id.",
  {
    id: z.string().describe("Fixture note id to look up."),
  },
  async ({ id }) => ({
    content: [{ type: "text", text: notes.get(id) ?? "missing-note" }],
  }),
);

await server.connect(new StdioServerTransport());
`,
    { encoding: "utf8", mode: 0o755 },
  );
}
