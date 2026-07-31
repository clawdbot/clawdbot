import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function createTempHome(): Promise<string> {
  return tempDirs.make("openclaw-mcp-probe-process-");
}

async function writeConfig(home: string, servers: Record<string, unknown>): Promise<string> {
  const configPath = path.join(home, "openclaw.json");
  await fs.writeFile(configPath, `${JSON.stringify({ mcp: { servers } })}\n`, "utf8");
  return configPath;
}

async function writeProbeServer(filePath: string): Promise<void> {
  await fs.writeFile(
    filePath,
    `let buffer = "";
function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}
function handle(message) {
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "probe-process-test", version: "1.0.0" },
      },
    });
    return;
  }
  if (message.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { tools: [{ name: "ping", inputSchema: { type: "object" } }] },
    });
  }
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf("\\n");
    if (newline < 0) return;
    const line = buffer.slice(0, newline).replace(/\\r$/, "");
    buffer = buffer.slice(newline + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
`,
    "utf8",
  );
}

function runProbe(home: string, args: string[]) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    OPENCLAW_CONFIG_PATH: path.join(home, "openclaw.json"),
    OPENCLAW_STATE_DIR: path.join(home, "state"),
    OPENCLAW_TEST_FAST: "1",
    MCP_TEST_ARGS_JSON: JSON.stringify(args),
  };
  delete env.VITEST;
  delete env.VITEST_POOL_ID;
  delete env.VITEST_WORKER_ID;
  const mcpCliUrl = new URL("./mcp-cli.ts", import.meta.url).href;
  const oneShotExitUrl = new URL("./one-shot-exit.ts", import.meta.url).href;
  const script = `
    import { Command } from "commander";
    import { registerMcpCli } from ${JSON.stringify(mcpCliUrl)};
    import { runCliWithExitFinalization } from ${JSON.stringify(oneShotExitUrl)};
    const program = new Command();
    program.exitOverride();
    registerMcpCli(program);
    await runCliWithExitFinalization({
      run: async () => {
        await program.parseAsync(JSON.parse(process.env.MCP_TEST_ARGS_JSON), { from: "user" });
      },
      onError: (error) => { throw error; },
    });
  `;
  return spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
    encoding: "utf8",
    env,
    maxBuffer: 4 * 1024 * 1024,
    timeout: 30_000,
  });
}

describe("mcp probe process exit", () => {
  it("prints named JSON diagnostics before exiting nonzero", async () => {
    const home = await createTempHome();
    const configPath = await writeConfig(home, {
      broken: { command: path.join(home, "missing-mcp-server") },
    });

    const result = runProbe(home, ["mcp", "probe", "broken", "--json"]);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    const output = JSON.parse(result.stdout) as {
      diagnostics: Array<{ message: string; serverName: string }>;
      servers: Record<string, unknown>;
    };
    expect(output.servers).toEqual({});
    expect(output.diagnostics).toEqual([expect.objectContaining({ serverName: "broken" })]);
    expect(result.stderr).toContain(`MCP probe failed for "broken" in ${configPath}:`);
  });

  it("preserves mixed partial text output before exiting nonzero", async () => {
    const home = await createTempHome();
    const serverPath = path.join(home, "probe-server.mjs");
    await writeProbeServer(serverPath);
    await writeConfig(home, {
      healthy: { command: process.execPath, args: [serverPath] },
      broken: { command: path.join(home, "missing-mcp-server") },
    });

    const result = runProbe(home, ["mcp", "probe"]);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("- healthy: 1 tools");
    expect(result.stdout).toContain("! broken:");
  });

  it("fails when an enabled server is omitted without a diagnostic", async () => {
    const home = await createTempHome();
    await writeConfig(home, { incomplete: {} });

    const result = runProbe(home, ["mcp", "probe", "incomplete", "--json"]);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ servers: {}, diagnostics: [] });
    expect(result.stderr).toContain('MCP probe did not connect to "incomplete"');
  });

  it("keeps healthy output successful and ignores disabled entries", async () => {
    const home = await createTempHome();
    const serverPath = path.join(home, "probe-server.mjs");
    await writeProbeServer(serverPath);
    await writeConfig(home, {
      healthy: { command: process.execPath, args: [serverPath] },
      disabled: { enabled: false },
    });

    const result = runProbe(home, ["mcp", "probe", "--json"]);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      diagnostics: [],
      servers: { healthy: { tools: 1 } },
    });
  });
});
