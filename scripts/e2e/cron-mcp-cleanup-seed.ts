import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { applyDockerOpenAiProviderConfig, type OpenClawConfig } from "./docker-openai-seed.ts";

const require = createRequire(import.meta.url);

async function writeProbeServer(params: {
  serverPath: string;
  pidPath: string;
  pidsPath: string;
  exitPath: string;
}) {
  const sdkMcpServerPath = require.resolve("@modelcontextprotocol/sdk/server/mcp.js");
  const sdkStdioServerPath = require.resolve("@modelcontextprotocol/sdk/server/stdio.js");
  await fs.writeFile(
    params.serverPath,
    `#!/usr/bin/env node
import fs from "node:fs";
import fsp from "node:fs/promises";
import { McpServer } from ${JSON.stringify(sdkMcpServerPath)};
import { StdioServerTransport } from ${JSON.stringify(sdkStdioServerPath)};

process.title = "openclaw-cron-mcp-cleanup-probe";
await fsp.mkdir(${JSON.stringify(path.dirname(params.pidPath))}, { recursive: true });
await fsp.writeFile(${JSON.stringify(params.pidPath)}, String(process.pid), "utf8");
await fsp.appendFile(${JSON.stringify(params.pidsPath)}, String(process.pid) + "\\n", "utf8");
process.once("exit", () => {
  try {
    fs.writeFileSync(${JSON.stringify(params.exitPath)}, "exited", "utf8");
  } catch {}
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    process.exit(0);
  });
}

setInterval(() => {}, 1000);

const server = new McpServer({ name: "cron-mcp-cleanup-probe", version: "1.0.0" });
server.tool("cleanup_probe", "Cron MCP cleanup probe", async () => ({
  content: [{ type: "text", text: "cron-mcp-cleanup-ok" }],
}));

await server.connect(new StdioServerTransport());
`,
    { encoding: "utf-8", mode: 0o755 },
  );
}

async function main() {
  const stateDir = process.env.OPENCLAW_STATE_DIR?.trim() || path.join(os.homedir(), ".openclaw");
  const configPath =
    process.env.OPENCLAW_CONFIG_PATH?.trim() || path.join(stateDir, "openclaw.json");
  const probeDir = path.join(stateDir, "cron-mcp-cleanup");
  const serverPath = path.join(probeDir, "probe-server.mjs");
  const pidPath = path.join(probeDir, "probe.pid");
  const pidsPath = path.join(probeDir, "probe.pids");
  const exitPath = path.join(probeDir, "probe.exit");

  await fs.mkdir(probeDir, { recursive: true });
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.rm(pidPath, { force: true });
  await fs.rm(pidsPath, { force: true });
  await fs.rm(exitPath, { force: true });
  await writeProbeServer({ serverPath, pidPath, pidsPath, exitPath });

  const seededConfig = applyDockerOpenAiProviderConfig(
    {
      gateway: {
        controlUi: {
          allowInsecureAuth: true,
          enabled: false,
        },
      },
      cron: {
        enabled: false,
      },
      agents: {
        defaults: {
          skipBootstrap: true,
          contextInjection: "never",
          skills: [],
          subagents: {
            runTimeoutSeconds: 8,
          },
        },
      },
      tools: {
        profile: "coding",
        subagents: {
          tools: {
            alsoAllow: ["bundle-mcp"],
          },
        },
      },
      mcp: {
        servers: {
          cronCleanupProbe: {
            command: "node",
            args: [serverPath],
            cwd: probeDir,
          },
        },
      },
    } satisfies OpenClawConfig,
    "sk-docker-cron-mcp-cleanup-test",
  );

  await fs.writeFile(configPath, `${JSON.stringify(seededConfig, null, 2)}\n`, "utf-8");

  process.stdout.write(
    JSON.stringify({
      ok: true,
      stateDir,
      configPath,
      serverPath,
      pidPath,
      pidsPath,
      exitPath,
    }) + "\n",
  );
}

await main();
