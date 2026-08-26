// Agent Plugin Gateway E2E proves installed portable bundles through a real dev gateway.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { applyMockOpenAiModelConfig } from "./e2e/lib/fixtures/mock-openai-config.mjs";
import { stopChild as stopProcessTree } from "./lib/gateway-bench-child.ts";

const LABEL = "agent-plugin-gateway-e2e";
const PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
const GATEWAY_TOKEN = "agent-plugin-gateway-e2e";
const MAX_LOG_BYTES = 128 * 1024;

type CapturedChild = {
  child: ChildProcessWithoutNullStreams;
  label: string;
  stderr: string;
  stdout: string;
};

type ResponsesPayload = {
  output?: Array<{
    content?: Array<{ text?: string; type?: string }>;
    type?: string;
  }>;
};

type E2eConfig = Record<string, unknown> & {
  agents?: Record<string, unknown> & { defaults?: Record<string, unknown> };
  gateway?: Record<string, unknown>;
  tools?: Record<string, unknown>;
};

function appendBounded(current: string, chunk: Buffer | string): string {
  const next = `${current}${chunk.toString()}`;
  return next.length <= MAX_LOG_BYTES ? next : next.slice(-MAX_LOG_BYTES);
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function spawnCaptured(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; label: string },
): CapturedChild {
  const child = spawn(command, args, {
    cwd: options.cwd,
    detached: process.platform !== "win32",
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end();
  const captured: CapturedChild = {
    child,
    label: options.label,
    stderr: "",
    stdout: "",
  };
  captured.child.stdout?.on("data", (chunk: Buffer) => {
    captured.stdout = appendBounded(captured.stdout, chunk);
  });
  captured.child.stderr?.on("data", (chunk: Buffer) => {
    captured.stderr = appendBounded(captured.stderr, chunk);
  });
  return captured;
}

async function waitForExit(child: CapturedChild, timeoutMs = 120_000): Promise<void> {
  if (child.child.exitCode !== null) {
    if (child.child.exitCode !== 0) {
      throw childFailure(child);
    }
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      void stopChild(child).finally(() => {
        reject(new Error(`${child.label} timed out after ${timeoutMs}ms`));
      });
    }, timeoutMs);
    child.child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      reject(childFailure(child, code, signal));
    });
  });
}

function childFailure(child: CapturedChild, code = child.child.exitCode, signal?: string | null) {
  return new Error(
    `${child.label} failed (exit ${code ?? "unknown"}${signal ? `, signal ${signal}` : ""})\n` +
      (child.stderr || child.stdout || "<no output>"),
  );
}

async function stopChild(child: CapturedChild | undefined): Promise<void> {
  if (!child) {
    return;
  }
  await stopProcessTree(child.child);
}

async function waitForHttp(url: string, child: CapturedChild, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.child.exitCode !== null) {
      throw childFailure(child);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) {
        return;
      }
    } catch {
      // The service is still starting.
    }
    await delay(100);
  }
  throw new Error(`${child.label} did not become ready at ${url}\n${child.stderr}`);
}

async function waitForOutputLine(
  child: CapturedChild,
  predicate: (line: string) => boolean,
  timeoutMs = 30_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.child.exitCode !== null) {
      throw childFailure(child);
    }
    const line = `${child.stdout}\n${child.stderr}`.split(/\r?\n/u).find(predicate);
    if (line) {
      return line;
    }
    await delay(50);
  }
  throw new Error(`${child.label} did not emit the expected output\n${child.stderr}`);
}

async function writeFixture(pluginRoot: string): Promise<void> {
  const skillDir = path.join(pluginRoot, "skills", "forecast-brief");
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        $schema: PLUGIN_SCHEMA,
        name: "weather-helper",
        extensions: {
          "ai.openclaw": { activation: { onStartup: true } },
          "com.example.other": { ignored: true },
        },
      },
      null,
      2,
    )}\n`,
  );
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    "---\nname: forecast-brief\ndescription: Summarize a weather forecast.\n---\n\nUse the weather probe when asked for a forecast.\n",
  );
  await fs.writeFile(
    path.join(pluginRoot, "mcp.json"),
    `${JSON.stringify(
      {
        $schema: MCP_SCHEMA,
        mcpServers: {
          "weather-probe": {
            type: "stdio",
            command: "node",
            args: ["${PLUGIN_ROOT}/server.mjs"],
            env: { PROBE_MODE: "live" },
            cwd: "${PLUGIN_DATA}",
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  await fs.writeFile(
    path.join(pluginRoot, "server.mjs"),
    `import fs from "node:fs";
import path from "node:path";

const pluginData = process.env.PLUGIN_DATA ?? "";
fs.writeFileSync(
  path.join(pluginData, "probe-launch.txt"),
  JSON.stringify({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    pluginData,
    pluginRoot: process.env.PLUGIN_ROOT,
  }),
  "utf8",
);
let buffer = "";
function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}
function handle(message) {
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "weather-probe", version: "1.0.0" },
      },
    });
    return;
  }
  if (message.method === "notifications/initialized") return;
  if (message.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [{
          name: "weather_probe",
          description: "Reports the Agent Plugins subprocess environment contract.",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
        }],
      },
    });
    return;
  }
  if (message.method === "tools/call") {
    const text = [
      "probe ok",
      "PLUGIN_ROOT=" + process.env.PLUGIN_ROOT,
      "PLUGIN_DATA=" + process.env.PLUGIN_DATA,
      "PROBE_MODE=" + process.env.PROBE_MODE,
    ].join("; ");
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { content: [{ type: "text", text }], isError: false },
    });
  }
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf("\\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline).replace(/\\r$/, "");
    buffer = buffer.slice(newline + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
`,
  );
}

async function writeConfig(params: {
  configPath: string;
  gatewayPort: number;
  mockPort: number;
  workspaceDir: string;
}): Promise<void> {
  const installedConfig = JSON.parse(await fs.readFile(params.configPath, "utf8")) as E2eConfig;
  const cfg: E2eConfig = {
    ...installedConfig,
    agents: {
      ...installedConfig.agents,
      defaults: { ...installedConfig.agents?.defaults, workspace: params.workspaceDir },
    },
    gateway: {
      ...installedConfig.gateway,
      mode: "local",
      bind: "loopback",
      port: params.gatewayPort,
      auth: { mode: "token", token: GATEWAY_TOKEN },
      controlUi: { enabled: false },
      http: { endpoints: { responses: { enabled: true } } },
    },
    tools: { ...installedConfig.tools, profile: "coding" },
  };
  applyMockOpenAiModelConfig(cfg, { mockPort: params.mockPort });
  await fs.writeFile(params.configPath, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
}

function responseText(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }
  const output = (payload as ResponsesPayload).output;
  return (output ?? [])
    .flatMap((item) => item.content ?? [])
    .filter((content) => content.type === "output_text" && typeof content.text === "string")
    .map((content) => content.text)
    .join("\n");
}

async function main(): Promise<void> {
  const repoRoot = path.resolve(import.meta.dirname, "..");
  const devRunnerPath = path.join(repoRoot, "scripts", "run-node.mjs");
  const entryPath = path.join(repoRoot, "dist", "index.js");
  const rootDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-plugin-gateway-")),
  );
  const keep = process.env.OPENCLAW_AGENT_PLUGIN_GATEWAY_E2E_KEEP === "1";
  const stateDir = path.join(rootDir, "state");
  const configPath = path.join(stateDir, "openclaw.json");
  const fixtureDir = path.join(rootDir, "weather-helper");
  const workspaceDir = path.join(rootDir, "workspace");
  const mockPort = await freePort();
  let gatewayPort = await freePort();
  while (gatewayPort === mockPort) {
    gatewayPort = await freePort();
  }
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    OPENAI_API_KEY: "agent-plugin-gateway-e2e",
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_NO_RESPAWN: "1",
    OPENCLAW_SKIP_CHANNELS: "1",
    OPENCLAW_SKIP_STARTUP_MODEL_PREWARM: "1",
    OPENCLAW_STATE_DIR: stateDir,
  };
  let mock: CapturedChild | undefined;
  let gateway: CapturedChild | undefined;
  let install: CapturedChild | undefined;
  const handleSignal = () => {
    void stopChild(gateway);
    void stopChild(mock);
    void stopChild(install);
  };
  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);
  try {
    await fs.mkdir(stateDir, { recursive: true });
    await fs.mkdir(workspaceDir, { recursive: true });
    await writeFixture(fixtureDir);

    install = spawnCaptured(
      process.execPath,
      [devRunnerPath, "plugins", "install", fixtureDir, "--force"],
      { cwd: repoRoot, env: childEnv, label: "plugin install" },
    );
    await waitForExit(install);
    await writeConfig({ configPath, gatewayPort, mockPort, workspaceDir });

    mock = spawnCaptured(process.execPath, ["scripts/e2e/mock-openai-server.mjs"], {
      cwd: repoRoot,
      env: { ...childEnv, MOCK_PORT: String(mockPort) },
      label: "mock OpenAI server",
    });
    await waitForHttp(`http://127.0.0.1:${mockPort}/health`, mock);

    gateway = spawnCaptured(
      process.execPath,
      [entryPath, "gateway", "--port", String(gatewayPort), "--bind", "loopback"],
      { cwd: repoRoot, env: childEnv, label: "gateway" },
    );
    await waitForHttp(`http://127.0.0.1:${gatewayPort}/health`, gateway, 120_000);
    const startupLog = await waitForOutputLine(
      gateway,
      (line) => line.includes("http server listening (") && line.includes("weather-helper"),
    );

    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${GATEWAY_TOKEN}`,
        "content-type": "application/json",
        "x-openclaw-agent": "main",
        "x-openclaw-scopes": "operator.write",
        "x-openclaw-session-key": "agent:main:openresponses:agent-plugin-gateway-e2e",
      },
      body: JSON.stringify({
        model: "openclaw/main",
        input: "agent plugin bundle qa check",
        max_output_tokens: 256,
        stream: false,
      }),
      signal: AbortSignal.timeout(180_000),
    });
    const responseBody = await response.text();
    if (!response.ok) {
      throw new Error(`gateway response failed (${response.status}): ${responseBody}`);
    }
    const finalText = responseText(JSON.parse(responseBody) as unknown);
    if (!finalText.includes("AGENT_BUNDLE_MCP_OK")) {
      throw new Error(`unexpected final response: ${finalText || responseBody}`);
    }

    const pluginOutput = `${install.stdout}\n${install.stderr}\n${gateway.stdout}\n${gateway.stderr}`;
    if (
      pluginOutput.includes("com.example.other") ||
      pluginOutput.includes("ignoring Agent Plugins")
    ) {
      throw new Error(`foreign extension namespace produced plugin diagnostics:\n${pluginOutput}`);
    }

    const installedPlugin = await fs.realpath(path.join(stateDir, "extensions", "weather-helper"));
    const pluginData = path.join(stateDir, "plugin-data", "weather-helper");
    const launchMarker = path.join(pluginData, "probe-launch.txt");
    const launchPayload = JSON.parse(await fs.readFile(launchMarker, "utf8")) as {
      argv?: unknown;
      cwd?: unknown;
      pluginData?: unknown;
      pluginRoot?: unknown;
    };
    const expectedLaunch = {
      argv: [],
      cwd: pluginData,
      pluginData,
      pluginRoot: installedPlugin,
    };
    if (JSON.stringify(launchPayload) !== JSON.stringify(expectedLaunch)) {
      throw new Error(
        `invalid probe launch contract: ${JSON.stringify({ expectedLaunch, launchPayload })}`,
      );
    }
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          finalText,
          installedPlugin,
          launchMarker,
          startupLog,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    process.off("SIGINT", handleSignal);
    process.off("SIGTERM", handleSignal);
    await stopChild(gateway);
    await stopChild(mock);
    await stopChild(install);
    if (!keep) {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  }
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  process.stderr.write(`${message}\n[${LABEL}] FAILED (exit 1)\n`);
  process.exitCode = 1;
}
