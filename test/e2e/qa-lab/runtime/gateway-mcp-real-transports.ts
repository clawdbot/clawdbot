import { existsSync } from "node:fs";
import fs from "node:fs/promises";
// QA Lab producer proves Gateway and MCP scenarios across real process and protocol boundaries.
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  QA_EVIDENCE_FILENAME,
  startQaGatewayChild,
  type QaEvidenceSummaryJson,
  type QaGatewayChildListeningContext,
} from "../../../../extensions/qa-lab/api.js";
import {
  PROTOCOL_VERSION,
  MIN_CLIENT_PROTOCOL_VERSION,
} from "../../../../packages/gateway-protocol/src/version.js";
import { runGatewaySmoke } from "../../../../scripts/dev/gateway-smoke.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import { formatErrorMessage } from "../../../../src/infra/errors.js";
import { createMcpClientTempState } from "./mcp-client-temp-state.fixture.ts";
import { createQaScriptEvidenceWriter, type QaScriptEvidenceStatus } from "./script-evidence.ts";

const FIXTURE_PLUGIN_ID = "qa-real-transports-fixture";
const FIXTURE_TOOL_NAME = "memory_search";
const FIXTURE_FACT = "MCP fact: the codename is ORBIT-9.";
const STARTUP_GATE_TIMEOUT_MS = 30_000;
const MCP_CONNECT_TIMEOUT_MS = 30_000;
const SOURCE_PATH = "test/e2e/qa-lab/runtime/gateway-mcp-real-transports.ts";

type ScenarioId = "gateway-smoke" | "mcp-gateway-connect-startup-retry" | "mcp-plugin-tools-call";

type ProducerOptions = {
  artifactBase: string;
  repoRoot: string;
  scenarioId: ScenarioId;
};

type ProofResult = {
  details?: string;
  durationMs: number;
  status: QaScriptEvidenceStatus;
};

type GatewayFrameCapture = {
  connectFrames: Array<{ minProtocol: number; maxProtocol: number }>;
  helloProtocols: number[];
  startupUnavailableResponses: number;
};

type GatewayProxy = {
  capture: GatewayFrameCapture;
  stop: () => Promise<void>;
  url: string;
};

type ChannelMcpInvocation = {
  args: string[];
  command: string;
  cwd: string;
  envPatch: NodeJS.ProcessEnv;
};

type McpClientHandle = {
  client: Client;
  cleanup: () => void;
  stderr: () => string;
  transport: StdioClientTransport;
};

const SCENARIOS = {
  "gateway-smoke": {
    title: "Gateway smoke evidence",
    sourcePath: "qa/scenarios/runtime/gateway-smoke.yaml",
    primaryCoverageIds: [
      "gateway.websocket-transport",
      "gateway.health-apis",
      "gateway.hello-ok-snapshot",
    ],
    docsRefs: ["docs/gateway/index.md", "docs/concepts/qa-e2e-automation.md"],
    codeRefs: [
      SOURCE_PATH,
      "extensions/qa-lab/src/gateway-child.ts",
      "scripts/dev/gateway-smoke.ts",
    ],
  },
  "mcp-gateway-connect-startup-retry": {
    title: "MCP Gateway connect startup retry",
    sourcePath: "qa/scenarios/runtime/mcp-gateway-connect-startup-retry.yaml",
    primaryCoverageIds: [
      "gateway.connect-request",
      "gateway.protocol-version-negotiation",
      "gateway.startup-retry",
    ],
    docsRefs: ["docs/gateway/protocol.md", "docs/cli/mcp.md"],
    codeRefs: [SOURCE_PATH, "extensions/qa-lab/src/gateway-child.ts", "src/mcp/channel-bridge.ts"],
  },
  "mcp-plugin-tools-call": {
    title: "MCP plugin-tools call",
    sourcePath: "qa/scenarios/plugins/mcp-plugin-tools-call.yaml",
    primaryCoverageIds: ["plugins.mcp-tools", "tools.invocation"],
    docsRefs: ["docs/cli/mcp.md", "docs/gateway/protocol.md"],
    codeRefs: [SOURCE_PATH, "src/mcp/plugin-tools-serve.ts", "src/mcp/plugin-tools-handlers.ts"],
  },
} as const;

function parseOptions(argv: readonly string[]): ProducerOptions {
  const readValue = (name: string) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const scenarioId = readValue("--scenario");
  if (!scenarioId || !(scenarioId in SCENARIOS)) {
    throw new Error(`--scenario must be one of: ${Object.keys(SCENARIOS).join(", ")}`);
  }
  const artifactBase = readValue("--artifact-base");
  if (!artifactBase) {
    throw new Error("--artifact-base is required");
  }
  return {
    artifactBase: path.resolve(artifactBase),
    repoRoot: path.resolve(readValue("--repo-root") ?? process.cwd()),
    scenarioId: scenarioId as ScenarioId,
  };
}

async function createFixturePlugin() {
  // openclaw-temp-dir: allow standalone producer cleans this root in each scenario finally block
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gateway-mcp-fixture-"));
  const pluginDir = path.join(root, FIXTURE_PLUGIN_ID);
  const startupGatePath = path.join(root, "startup-connect-observed");
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(
    path.join(pluginDir, "openclaw.plugin.json"),
    `${JSON.stringify(
      {
        id: FIXTURE_PLUGIN_ID,
        activation: { onStartup: true },
        configSchema: { type: "object", additionalProperties: false, properties: {} },
        contracts: { tools: [FIXTURE_TOOL_NAME] },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(pluginDir, "index.js"),
    `const fs = require("node:fs");

module.exports = {
  id: ${JSON.stringify(FIXTURE_PLUGIN_ID)},
  register(api) {
    api.registerTool({
      name: ${JSON.stringify(FIXTURE_TOOL_NAME)},
      description: "Search fixture memory",
      parameters: {
        type: "object",
        properties: { query: { type: "string" }, maxResults: { type: "number" } },
        required: ["query"],
      },
      async execute(_toolCallId, params) {
        return { content: [{ type: "text", text: ${JSON.stringify(FIXTURE_FACT)} + " query=" + String(params.query) }] };
      },
    });
    api.registerService({
      id: "qa-startup-delay",
      async start() {
        const deadline = Date.now() + ${STARTUP_GATE_TIMEOUT_MS};
        while (!fs.existsSync(${JSON.stringify(startupGatePath)})) {
          if (Date.now() >= deadline) {
            throw new Error("timed out waiting for the QA MCP startup connect frame");
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      },
      stop() {},
    });
  },
};\n`,
    "utf8",
  );
  return {
    pluginDir,
    startupGatePath,
    cleanup: () => fs.rm(root, { force: true, recursive: true }),
  };
}

function withFixturePlugin(config: OpenClawConfig, pluginDir: string): OpenClawConfig {
  const existingPaths = config.plugins?.load?.paths ?? [];
  const existingAllow = config.plugins?.allow ?? [];
  return {
    ...config,
    plugins: {
      ...config.plugins,
      enabled: true,
      allow: [...new Set([...existingAllow, FIXTURE_PLUGIN_ID])],
      load: {
        ...config.plugins?.load,
        paths: [...new Set([...existingPaths, pluginDir])],
      },
      entries: {
        ...config.plugins?.entries,
        [FIXTURE_PLUGIN_ID]: { enabled: true },
      },
    },
  };
}

function resolveChannelMcpInvocation(params: {
  gatewayToken: string;
  gatewayUrl: string;
  repoRoot: string;
  tokenFile: string;
}): ChannelMcpInvocation {
  for (const relativePath of ["dist/index.mjs", "dist/index.js"]) {
    const entryPath = path.join(params.repoRoot, relativePath);
    if (existsSync(entryPath)) {
      return {
        args: [
          entryPath,
          "mcp",
          "serve",
          "--url",
          params.gatewayUrl,
          "--token-file",
          params.tokenFile,
          "--claude-channel-mode",
          "off",
          "--verbose",
        ],
        command: process.execPath,
        cwd: params.repoRoot,
        envPatch: {},
      };
    }
  }

  const channelServerPath = path.join(params.repoRoot, "src/mcp/channel-server.ts");
  if (existsSync(channelServerPath)) {
    const channelServerUrl = pathToFileURL(channelServerPath).href;
    return {
      args: [
        "--import",
        "tsx",
        "--eval",
        [
          `import(${JSON.stringify(channelServerUrl)})`,
          `.then((module) => module.serveOpenClawChannelMcp({`,
          `gatewayUrl: process.env.OPENCLAW_QA_GATEWAY_URL,`,
          `gatewayToken: process.env.OPENCLAW_QA_GATEWAY_TOKEN,`,
          `claudeChannelMode: "off",`,
          `verbose: true`,
          `}))`,
        ].join(""),
      ],
      command: process.execPath,
      cwd: params.repoRoot,
      envPatch: {
        OPENCLAW_QA_GATEWAY_TOKEN: params.gatewayToken,
        OPENCLAW_QA_GATEWAY_URL: params.gatewayUrl,
      },
    };
  }

  throw new Error(
    "OpenClaw channel MCP entry not found: expected dist/index.(m)js or src/mcp/channel-server.ts",
  );
}

function parseJsonFrame(data: RawData): Record<string, unknown> | null {
  try {
    const text = Array.isArray(data)
      ? Buffer.concat(data.map((chunk) => Buffer.from(chunk))).toString("utf8")
      : Buffer.isBuffer(data)
        ? data.toString("utf8")
        : Buffer.from(data).toString("utf8");
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function startGatewayProxy(
  upstreamUrl: string,
  onConnectFrame?: () => void,
): Promise<GatewayProxy> {
  const capture: GatewayFrameCapture = {
    connectFrames: [],
    helloProtocols: [],
    startupUnavailableResponses: 0,
  };
  const connectRequestIds = new Set<string>();
  const server: Server = createServer();
  const wss = new WebSocketServer({ server });
  wss.on("connection", (downstream) => {
    const upstream = new WebSocket(upstreamUrl);
    const pending: RawData[] = [];
    downstream.on("message", (data) => {
      const frame = parseJsonFrame(data);
      if (frame?.method === "connect" && typeof frame.id === "string") {
        const params = frame.params as Record<string, unknown> | undefined;
        if (typeof params?.minProtocol === "number" && typeof params.maxProtocol === "number") {
          capture.connectFrames.push({
            minProtocol: params.minProtocol,
            maxProtocol: params.maxProtocol,
          });
          connectRequestIds.add(frame.id);
          onConnectFrame?.();
        }
      }
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(data);
      } else {
        pending.push(data);
      }
    });
    upstream.on("open", () => {
      for (const data of pending.splice(0)) {
        upstream.send(data);
      }
    });
    upstream.on("message", (data) => {
      const frame = parseJsonFrame(data);
      if (typeof frame?.id === "string" && connectRequestIds.has(frame.id)) {
        const error = frame.error as Record<string, unknown> | undefined;
        const details = error?.details as Record<string, unknown> | undefined;
        if (error?.retryable === true && details?.reason === "startup-sidecars") {
          capture.startupUnavailableResponses += 1;
        }
        const payload = frame.payload as Record<string, unknown> | undefined;
        if (payload?.type === "hello-ok" && typeof payload.protocol === "number") {
          capture.helloProtocols.push(payload.protocol);
        }
      }
      if (downstream.readyState === WebSocket.OPEN) {
        downstream.send(data);
      }
    });
    const closeDownstream = () => {
      if (downstream.readyState === WebSocket.OPEN) {
        downstream.close(1013, "gateway unavailable");
      }
    };
    upstream.on("error", closeDownstream);
    upstream.on("close", (code, reason) => {
      if (downstream.readyState === WebSocket.OPEN) {
        downstream.close(code, reason.toString());
      }
    });
    downstream.on("close", () => upstream.close());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("gateway frame proxy did not bind a TCP port");
  }
  return {
    capture,
    url: `ws://127.0.0.1:${address.port}`,
    async stop() {
      for (const client of wss.clients) {
        client.terminate();
      }
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

async function connectChannelMcpClient(params: {
  gatewayUrl: string;
  gatewayToken: string;
  repoRoot: string;
}): Promise<McpClientHandle> {
  const tempState = createMcpClientTempState({ gatewayToken: params.gatewayToken });
  const mcpInvocation = resolveChannelMcpInvocation({
    gatewayToken: params.gatewayToken,
    gatewayUrl: params.gatewayUrl,
    repoRoot: params.repoRoot,
    tokenFile: tempState.tokenFile,
  });
  const stderrChunks: Buffer[] = [];
  const transport = new StdioClientTransport({
    command: mcpInvocation.command,
    args: mcpInvocation.args,
    cwd: mcpInvocation.cwd,
    env: {
      ...process.env,
      ...mcpInvocation.envPatch,
      OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: "1",
      OPENCLAW_LOG_LEVEL: "debug",
      OPENCLAW_STATE_DIR: tempState.stateDir,
    },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
  const client = new Client({ name: "qa-gateway-mcp-client", version: "1.0.0" });
  let connectTimeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      client.connect(transport),
      new Promise<never>((_, reject) => {
        connectTimeout = setTimeout(
          () => reject(new Error("MCP channel client connect timed out")),
          MCP_CONNECT_TIMEOUT_MS,
        );
      }),
    ]);
    return {
      client,
      cleanup: tempState.cleanup,
      transport,
      stderr: () => Buffer.concat(stderrChunks).toString("utf8"),
    };
  } catch (error) {
    await Promise.allSettled([client.close(), transport.close()]);
    tempState.cleanup();
    throw error;
  } finally {
    if (connectTimeout) {
      clearTimeout(connectTimeout);
    }
  }
}

async function closeMcpClient(handle: McpClientHandle | undefined) {
  if (!handle) {
    return;
  }
  await Promise.allSettled([handle.client.close(), handle.transport.close()]);
  handle.cleanup();
}

async function approvePendingMcpPairing(gateway: Awaited<ReturnType<typeof startQaGatewayChild>>) {
  const pairing = (await gateway.call("device.pair.list", {})) as {
    pending?: Array<{ requestId?: string; role?: string }>;
  };
  const pending = pairing.pending?.find((entry) => entry.role === "operator");
  if (!pending?.requestId) {
    return false;
  }
  try {
    await gateway.call("device.pair.approve", { requestId: pending.requestId });
    return true;
  } catch (error) {
    if (formatErrorMessage(error).includes("unknown requestId")) {
      return false;
    }
    throw error;
  }
}

async function runGatewaySmokeProof(options: ProducerOptions): Promise<string> {
  const gateway = await startQaGatewayChild({
    repoRoot: options.repoRoot,
    useRepoCli: true,
    transportBaseUrl: "http://127.0.0.1",
    controlUiEnabled: false,
  });
  const tempRoot = gateway.tempRoot;
  const keepTemp = process.env.OPENCLAW_QA_KEEP_TEMP === "1";
  let details = "";
  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runGatewaySmoke(
      { token: gateway.token, urlRaw: gateway.wsUrl },
      {
        stdout: (message) => stdout.push(message),
        stderr: (message) => stderr.push(message),
      },
    );
    if (exitCode !== 0) {
      throw new Error(`gateway smoke exited ${exitCode}: ${stderr.join("\n")}`);
    }
    const health = (await gateway.call("health", {})) as { ok?: boolean };
    if (health.ok !== true) {
      throw new Error(`gateway health RPC returned ${JSON.stringify(health)}`);
    }
    details = `real Gateway pid=${gateway.pid ?? "unknown"}; ${stdout.join("; ")}; health.ok=true`;
  } finally {
    await gateway.stop();
  }
  if (!keepTemp && existsSync(tempRoot)) {
    throw new Error(`Gateway temp root was not cleaned up: ${tempRoot}`);
  }
  return details;
}

async function runMcpGatewayStartupRetryProof(options: ProducerOptions): Promise<string> {
  const fixture = await createFixturePlugin();
  let proxy: GatewayProxy | undefined;
  let mcp: McpClientHandle | undefined;
  let gateway: Awaited<ReturnType<typeof startQaGatewayChild>> | undefined;
  let beforeSpawnAt = 0;
  const keepTemp = process.env.OPENCLAW_QA_KEEP_TEMP === "1";
  let details = "";
  let proofError: Error | undefined;
  try {
    const onListening = async (context: QaGatewayChildListeningContext) => {
      await closeMcpClient(mcp);
      await proxy?.stop();
      proxy = await startGatewayProxy(context.wsUrl, () => {
        void fs.writeFile(fixture.startupGatePath, "observed\n", "utf8");
      });
      beforeSpawnAt = Date.now();
      mcp = await connectChannelMcpClient({
        gatewayUrl: proxy.url,
        gatewayToken: context.token,
        repoRoot: options.repoRoot,
      });
    };
    gateway = await startQaGatewayChild({
      repoRoot: options.repoRoot,
      useRepoCli: true,
      transportBaseUrl: "http://127.0.0.1",
      controlUiEnabled: false,
      onListening,
      mutateConfig: (config) => withFixturePlugin(config, fixture.pluginDir),
    });
    if (!proxy || !mcp) {
      throw new Error("MCP client was not started by the Gateway before-spawn hook");
    }
    const gatewayReadyAt = Date.now();
    if (beforeSpawnAt >= gatewayReadyAt) {
      throw new Error("MCP client did not start before Gateway readiness");
    }
    if (await approvePendingMcpPairing(gateway)) {
      await closeMcpClient(mcp);
      mcp = await connectChannelMcpClient({
        gatewayUrl: proxy.url,
        gatewayToken: gateway.token,
        repoRoot: options.repoRoot,
      });
    }
    const tools = await mcp.client.listTools();
    if (!tools.tools.some((tool) => tool.name === "conversations_list")) {
      throw new Error("real MCP channel server did not expose conversations_list");
    }
    const conversations = await mcp.client.callTool({
      name: "conversations_list",
      arguments: { limit: 1 },
    });
    if (conversations.isError) {
      throw new Error(`conversations_list failed: ${JSON.stringify(conversations.content)}`);
    }
    const capture = proxy.capture;
    if (capture.startupUnavailableResponses < 1) {
      throw new Error(
        `expected a retryable startup-unavailable response; captured=${JSON.stringify(capture)}`,
      );
    }
    if (
      !capture.connectFrames.some(
        (frame) =>
          frame.minProtocol === MIN_CLIENT_PROTOCOL_VERSION &&
          frame.maxProtocol === PROTOCOL_VERSION,
      )
    ) {
      throw new Error(
        `MCP Gateway connect frame used unexpected protocol range: ${JSON.stringify(capture)}`,
      );
    }
    if (!capture.helloProtocols.includes(PROTOCOL_VERSION)) {
      throw new Error(`MCP Gateway negotiation did not select protocol ${PROTOCOL_VERSION}`);
    }
    details = [
      `MCP started ${gatewayReadyAt - beforeSpawnAt}ms before Gateway readiness`,
      `startup retries=${capture.startupUnavailableResponses}`,
      `connect frames=${capture.connectFrames.length}`,
      `negotiated protocol=${PROTOCOL_VERSION}`,
    ].join("; ");
  } catch (error) {
    const diagnostics = [
      mcp?.stderr(),
      proxy ? `captured Gateway frames: ${JSON.stringify(proxy.capture)}` : undefined,
      gateway?.logs(),
    ]
      .filter((value): value is string => Boolean(value))
      .join("\n");
    proofError = new Error(`${formatErrorMessage(error)}${diagnostics ? `\n${diagnostics}` : ""}`, {
      cause: error,
    });
  } finally {
    await closeMcpClient(mcp);
    await proxy?.stop().catch(() => undefined);
    const tempRoot = gateway?.tempRoot;
    await gateway?.stop().catch(() => undefined);
    await fixture.cleanup();
    if (!keepTemp && tempRoot && existsSync(tempRoot) && !proofError) {
      proofError = new Error(`Gateway temp root was not cleaned up: ${tempRoot}`);
    }
  }
  if (proofError) {
    throw proofError;
  }
  return details;
}

async function writePluginToolsConfig(root: string, pluginDir: string) {
  const configPath = path.join(root, "openclaw.json");
  const config = withFixturePlugin({} as OpenClawConfig, pluginDir);
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return configPath;
}

async function runMcpPluginToolsProof(options: ProducerOptions): Promise<string> {
  const fixture = await createFixturePlugin();
  // openclaw-temp-dir: allow standalone producer cleans and verifies this root in its finally block
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-plugin-tools-mcp-"));
  const stateDir = path.join(runtimeRoot, "state");
  const homeDir = path.join(runtimeRoot, "home");
  await Promise.all([
    fs.mkdir(stateDir, { recursive: true }),
    fs.mkdir(homeDir, { recursive: true }),
  ]);
  const configPath = await writePluginToolsConfig(runtimeRoot, fixture.pluginDir);
  const stderrChunks: Buffer[] = [];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "--import",
      "tsx",
      "--eval",
      `import(${JSON.stringify(pathToFileURL(path.join(options.repoRoot, "src/mcp/plugin-tools-serve.ts")).href)}).then((module) => module.servePluginToolsMcp())`,
    ],
    cwd: options.repoRoot,
    env: {
      ...process.env,
      HOME: homeDir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_STATE_DIR: stateDir,
    },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
  const client = new Client({ name: "qa-plugin-tools-client", version: "1.0.0" });
  let details = "";
  let proofError: Error | undefined;
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    if (!listed.tools.some((tool) => tool.name === FIXTURE_TOOL_NAME)) {
      throw new Error(
        `fixture plugin tool was not listed: ${listed.tools.map((tool) => tool.name).join(", ")}`,
      );
    }
    const result = await client.callTool({
      name: FIXTURE_TOOL_NAME,
      arguments: { query: "ORBIT-9 codename", maxResults: 3 },
    });
    if (result.isError || !JSON.stringify(result.content).includes(FIXTURE_FACT)) {
      throw new Error(`fixture plugin tool returned unexpected payload: ${JSON.stringify(result)}`);
    }
    details = `real plugin-tools pid=${transport.pid ?? "unknown"}; listed and called ${FIXTURE_TOOL_NAME}; received ORBIT-9`;
  } catch (error) {
    const stderr = Buffer.concat(stderrChunks).toString("utf8");
    proofError = new Error(
      `${formatErrorMessage(error)}${stderr ? `\nplugin-tools stderr:\n${stderr}` : ""}`,
      {
        cause: error,
      },
    );
  } finally {
    await Promise.allSettled([client.close(), transport.close()]);
    await Promise.all([fixture.cleanup(), fs.rm(runtimeRoot, { force: true, recursive: true })]);
    if (existsSync(runtimeRoot) && !proofError) {
      proofError = new Error(`plugin-tools runtime root was not cleaned up: ${runtimeRoot}`);
    }
  }
  if (proofError) {
    throw proofError;
  }
  return details;
}

async function produceProof(options: ProducerOptions): Promise<ProofResult> {
  const startedAt = Date.now();
  try {
    const details =
      options.scenarioId === "gateway-smoke"
        ? await runGatewaySmokeProof(options)
        : options.scenarioId === "mcp-gateway-connect-startup-retry"
          ? await runMcpGatewayStartupRetryProof(options)
          : await runMcpPluginToolsProof(options);
    return { details, durationMs: Math.max(1, Date.now() - startedAt), status: "pass" };
  } catch (error) {
    return {
      details: formatErrorMessage(error),
      durationMs: Math.max(1, Date.now() - startedAt),
      status: "fail",
    };
  }
}

async function runGatewayMcpRealTransportProducer(
  options: ProducerOptions,
): Promise<QaEvidenceSummaryJson> {
  const scenario = SCENARIOS[options.scenarioId];
  const writer = createQaScriptEvidenceWriter({
    artifactBase: options.artifactBase,
    logFileName: `${options.scenarioId}.log`,
    primaryModel: "mock-openai/gpt-5.6-luna",
    providerMode: "mock-openai",
    repoRoot: options.repoRoot,
    target: {
      id: options.scenarioId,
      title: scenario.title,
      sourcePath: scenario.sourcePath,
      primaryCoverageIds: scenario.primaryCoverageIds,
      docsRefs: scenario.docsRefs,
      codeRefs: scenario.codeRefs,
    },
  });
  const result = await produceProof(options);
  writer.appendLog(`${result.status}: ${result.details ?? "no details"}\n`);
  return await writer.write(result);
}

async function main(argv: readonly string[]) {
  const options = parseOptions(argv);
  const evidence = await runGatewayMcpRealTransportProducer(options);
  const status = evidence.entries[0]?.result.status;
  console.log(`Gateway/MCP real transport evidence: ${QA_EVIDENCE_FILENAME}`);
  console.log(`Gateway/MCP real transport status: ${status}`);
  return status === "pass" ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2))
    .then((exitCode) => {
      process.exit(exitCode);
    })
    .catch((error: unknown) => {
      console.error(formatErrorMessage(error));
      process.exitCode = 1;
    });
}

export const testing = {
  resolveChannelMcpInvocation,
};
