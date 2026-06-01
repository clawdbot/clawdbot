import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { applyDockerOpenAiProviderConfig, type OpenClawConfig } from "./docker-openai-seed.ts";

const require = createRequire(import.meta.url);

async function writeProbeMcpServer(serverPath: string) {
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

async function main() {
  const stateDir = process.env.OPENCLAW_STATE_DIR?.trim() || path.join(os.homedir(), ".openclaw");
  const configPath =
    process.env.OPENCLAW_CONFIG_PATH?.trim() || path.join(stateDir, "openclaw.json");
  const workspaceDir = path.join(stateDir, "workspace");
  const serverPath = path.join(stateDir, "mcp-code-mode-fixture", "fixture-server.mjs");
  const apiKey =
    process.env.OPENAI_API_KEY?.trim() ||
    process.env.OPENCLAW_MCP_CODE_MODE_OPENAI_API_KEY?.trim() ||
    "sk-docker-smoke-test";

  const cfg = applyDockerOpenAiProviderConfig(
    {
      gateway: {
        controlUi: {
          allowInsecureAuth: true,
          enabled: false,
        },
        http: {
          endpoints: {
            responses: {
              enabled: true,
            },
          },
        },
      },
      agents: {
        defaults: {
          heartbeat: {
            every: "0m",
          },
          memorySearch: {
            enabled: false,
            sync: {
              onSearch: false,
              onSessionStart: false,
              watch: false,
            },
          },
        },
      },
      plugins: {
        slots: {
          memory: "none",
        },
      },
      tools: {
        profile: "coding",
        alsoAllow: ["bundle-mcp"],
        codeMode: {
          enabled: true,
          timeoutMs: 20_000,
          maxPendingToolCalls: 16,
        },
      },
      mcp: {
        servers: {
          fixture: {
            command: "node",
            args: [serverPath],
            cwd: path.dirname(serverPath),
            connectionTimeoutMs: 30_000,
          },
        },
      },
    } satisfies OpenClawConfig,
    apiKey,
  );

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.mkdir(workspaceDir, { recursive: true });
  await writeProbeMcpServer(serverPath);
  await fs.writeFile(configPath, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      stateDir,
      configPath,
      workspaceDir,
      serverPath,
    })}\n`,
  );
}

await main();
