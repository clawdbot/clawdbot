#!/usr/bin/env node
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const DEFAULT_PORT = 18789;
const SESSION_KEY = "agent:main:main";
const PLUGIN_ID = "pond-node-tools";
const MCP_PLUGIN_ID = "node-mcp";
const MCP_SERVER_NAME = "pond";
const MCP_TOOL_NAME = "pond_echo";
const SHARED_TOOL_NAME = "pond_shared_probe";
const SKILL_NAME = "pond-node-skill";
const LIVE_MODEL = "anthropic/claude-sonnet-4-6";
const LIVE_TURN_TIMEOUT_MS = 60_000;
const require = createRequire(import.meta.url);
let verboseOutput = false;

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      args._.push(value);
      continue;
    }
    const key = value.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    index += 1;
  }
  return args;
}

function requireWebSocket() {
  if (typeof WebSocket !== "function") {
    throw new Error("Node global WebSocket unavailable; run with Node 22+");
  }
}

function repoRoot() {
  return path.resolve(import.meta.dirname, "..", "..");
}

function now() {
  return Date.now();
}

function proofToken() {
  return `pond-proof-${crypto.randomBytes(12).toString("hex")}`;
}

async function availableLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  if (!port) {
    throw new Error("failed to allocate pond gateway port");
  }
  return port;
}

function logStep(message) {
  console.log(`[pond-proof] ${message}`);
}

async function writeJson(filePath, value, options = {}) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const data = `${JSON.stringify(value, null, 2)}\n`;
  if (typeof options.mode === "number") {
    await fs.writeFile(filePath, data, { encoding: "utf8", mode: options.mode, flag: "w" });
    await fs.chmod(filePath, options.mode);
    return;
  }
  await fs.writeFile(filePath, data, "utf8");
}

async function writeProofPlugin(rootDir, nodeLabel, options = {}) {
  const pluginDir = path.join(rootDir, "plugin");
  const pluginPath = path.join(pluginDir, "pond-node-tools.mjs");
  await fs.mkdir(pluginDir, { recursive: true });
  await writeJson(path.join(pluginDir, "openclaw.plugin.json"), {
    id: PLUGIN_ID,
    name: "Pond Node Tools",
    description: "Node-hosted plugin tool proof",
    activation: { onStartup: true },
    configSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  });
  await writeJson(path.join(pluginDir, "package.json"), {
    name: PLUGIN_ID,
    version: "0.0.0",
    type: "module",
    openclaw: { extensions: ["./pond-node-tools.mjs"] },
  });
  const sharedToolRegistration = options.sharedTool
    ? `
    api.registerNodeHostCommand({
      command: "pond.sharedProbe",
      agentTool: {
        name: ${JSON.stringify(SHARED_TOOL_NAME)},
        description: "Return the node label for collision-disambiguation proof.",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false
        },
        defaultPlatforms: ["linux", "macos"]
      },
      handle: async () => JSON.stringify(${JSON.stringify(`${nodeLabel}-shared-ok`)})
    });`
    : "";
  const source = `
import os from "node:os";

const nodeLabel = process.env.OPENCLAW_POND_NODE_LABEL || ${JSON.stringify(nodeLabel)};

function readParams(paramsJSON) {
  if (!paramsJSON) return {};
  try {
    const parsed = JSON.parse(paramsJSON);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export default {
  id: ${JSON.stringify(PLUGIN_ID)},
  name: "Pond Node Tools",
  description: "Node-hosted plugin tool proof",
  register(api) {
    api.registerNodeHostCommand({
      command: "pond.echo",
      agentTool: {
        name: "pond_echo",
        description: "Echo proof payload from the connected node host.",
        parameters: {
          type: "object",
          properties: {
            message: { type: "string" }
          },
          required: ["message"],
          additionalProperties: false
        },
        defaultPlatforms: ["linux", "macos"],
        mcp: { server: "pond-proof", tool: "echo" }
      },
      handle: async (paramsJSON) =>
        JSON.stringify({
          ok: true,
          nodeLabel,
          hostname: os.hostname(),
          params: readParams(paramsJSON)
        })
    });${sharedToolRegistration}
  }
};
`.trimStart();
  await fs.writeFile(pluginPath, source, "utf8");
  return pluginDir;
}

async function writeProofMcpServer(rootDir) {
  const serverPath = path.join(rootDir, "mcp", "pond-echo.mjs");
  const callLogPath = path.join(rootDir, "mcp", "calls.jsonl");
  const sdkMcpServerPath = require.resolve("@modelcontextprotocol/sdk/server/mcp.js");
  const sdkStdioServerPath = require.resolve("@modelcontextprotocol/sdk/server/stdio.js");
  const zodPath = require.resolve("zod");
  await fs.mkdir(path.dirname(serverPath), { recursive: true });
  const source = `#!/usr/bin/env node
import { appendFile } from "node:fs/promises";
import { McpServer } from ${JSON.stringify(sdkMcpServerPath)};
import { StdioServerTransport } from ${JSON.stringify(sdkStdioServerPath)};
import { z } from ${JSON.stringify(zodPath)};

const callLogPath = ${JSON.stringify(callLogPath)};
const server = new McpServer({ name: "pond-echo-fixture", version: "1.0.0" });

server.tool(
  ${JSON.stringify(MCP_TOOL_NAME)},
  "Echo a pond proof payload.",
  { text: z.string() },
  async ({ text }) => {
    await appendFile(callLogPath, JSON.stringify({ text }) + "\\n", "utf8");
    return {
      content: [{ type: "text", text: JSON.stringify({ text }) }],
    };
  },
);

await server.connect(new StdioServerTransport());
`;
  await fs.writeFile(serverPath, source, { encoding: "utf8", mode: 0o755 });
  return { callLogPath, serverPath };
}

async function writeProofSkill(stateDir, proof) {
  const skillPath = path.join(stateDir, "skills", SKILL_NAME, "SKILL.md");
  const content = `---\nname: ${SKILL_NAME}\ndescription: Pond node-hosted skill proof\n---\n\n# Pond node skill\n\nWhen asked for the pond marker, reply with exactly ${proof}.\n`;
  await fs.mkdir(path.dirname(skillPath), { recursive: true });
  await fs.writeFile(skillPath, content, "utf8");
  return skillPath;
}

async function prepareRoleState(baseDir, role, token, nodeLabel, options = {}) {
  const rootDir = path.resolve(baseDir, role);
  const stateDir = path.join(rootDir, "state");
  const configPath = path.join(rootDir, "openclaw.json");
  await fs.mkdir(rootDir, { recursive: true, mode: 0o700 });
  await fs.chmod(rootDir, 0o700);
  const pluginPath = await writeProofPlugin(rootDir, nodeLabel, {
    sharedTool: options.sharedTool === true,
  });
  const mcpFixture = options.nodeSurfaces ? await writeProofMcpServer(rootDir) : undefined;
  const mcpServerPath = mcpFixture?.serverPath;
  const skillPath = options.nodeSurfaces
    ? await writeProofSkill(stateDir, options.skillProofToken)
    : undefined;
  await writeJson(
    configPath,
    {
      gateway: {
        mode: "local",
        bind: "lan",
        auth: { mode: "token", token },
        nodes: {
          allowCommands: [
            "pond.echo",
            ...(options.sharedTool ? ["pond.sharedProbe"] : []),
            "system.run",
          ],
        },
      },
      tools: { exec: { host: "node", security: "full", ask: "off" } },
      ...(options.liveModel
        ? {
            agents: {
              defaults: {
                model: { primary: options.liveModel, fallbacks: [] },
              },
            },
          }
        : {}),
      plugins: {
        load: { paths: [pluginPath] },
        entries: { [PLUGIN_ID]: { enabled: true } },
      },
      ...(mcpServerPath
        ? {
            nodeHost: {
              mcp: {
                servers: {
                  [MCP_SERVER_NAME]: {
                    command: process.execPath,
                    args: [mcpServerPath],
                    transport: "stdio",
                  },
                },
              },
              skills: { enabled: true },
            },
          }
        : {}),
    },
    { mode: 0o600 },
  );
  await writeJson(path.join(stateDir, "agents", "main", "sessions", "sessions.json"), {
    [SESSION_KEY]: {
      sessionId: "pond-proof-main",
      updatedAt: now(),
      modelProvider: options.liveModel ? "anthropic" : "openai",
      model: options.liveModel ? "claude-sonnet-4-6" : "gpt-5.5",
    },
  });
  await writeJson(
    path.join(stateDir, "exec-approvals.json"),
    {
      version: 1,
      defaults: { security: "full", ask: "off" },
      agents: {},
    },
    { mode: 0o600 },
  );
  return {
    rootDir,
    stateDir,
    configPath,
    pluginPath,
    mcpServerPath,
    mcpCallLogPath: mcpFixture?.callLogPath,
    skillPath,
  };
}

function childEnv(state, token, nodeLabel) {
  return {
    ...process.env,
    OPENCLAW_CONFIG_PATH: state.configPath,
    OPENCLAW_STATE_DIR: state.stateDir,
    OPENCLAW_GATEWAY_TOKEN: token,
    OPENCLAW_POND_NODE_LABEL: nodeLabel,
  };
}

function spawnOpenClaw(args, options) {
  const cliArgs = options.built ? ["openclaw.mjs", ...args] : ["scripts/run-node.mjs", ...args];
  const child = spawn("node", cliArgs, {
    cwd: repoRoot(),
    env: options.env,
    stdio: options.stdio ?? "inherit",
  });
  child.on("exit", (code, signal) => {
    if (options.onExit) {
      options.onExit(code, signal);
    }
  });
  return child;
}

async function runCommand(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? repoRoot(),
    env: options.env ?? process.env,
    stdio: options.stdio ?? "inherit",
  });
  await waitForChild(child);
}

function waitForChild(child) {
  return new Promise((resolve, reject) => {
    child.once("exit", (code, signal) => {
      if (code === 0 || signal) {
        resolve({ code, signal });
        return;
      }
      reject(new Error(`child exited with code ${code}`));
    });
  });
}

async function runForegroundChild(child) {
  const forward = (signal) => {
    if (child.exitCode === null) {
      child.kill(signal);
    }
  };
  process.once("SIGTERM", forward);
  process.once("SIGINT", forward);
  try {
    await waitForChild(child);
  } finally {
    process.off("SIGTERM", forward);
    process.off("SIGINT", forward);
  }
}

function terminate(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

class GatewayRpc {
  constructor({ url, token, scopes }) {
    requireWebSocket();
    this.url = url;
    this.token = token;
    this.scopes = scopes;
    this.pending = new Map();
    this.nextId = 1;
  }

  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Gateway connect timeout: ${this.url}`)),
        15_000,
      );
      this.ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error(`Gateway socket error: ${this.url}`));
      });
    });
    this.ws.addEventListener("message", (event) => this.onMessage(event));
    await this.request("connect", {
      minProtocol: 1,
      maxProtocol: 99,
      client: {
        id: "gateway-client",
        displayName: "Pond proof verifier",
        version: "0.0.0",
        platform: process.platform,
        mode: "backend",
      },
      auth: { token: this.token },
      role: "operator",
      scopes: this.scopes,
    });
  }

  onMessage(event) {
    let frame;
    try {
      frame = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (frame?.type !== "res" || typeof frame.id !== "string") {
      return;
    }
    const pending = this.pending.get(frame.id);
    if (!pending) {
      return;
    }
    if (pending.expectFinal && frame.payload?.status === "accepted") {
      return;
    }
    this.pending.delete(frame.id);
    clearTimeout(pending.timer);
    if (frame.ok) {
      pending.resolve(frame.payload);
      return;
    }
    pending.reject(new Error(frame.error?.message ?? `Gateway RPC failed: ${pending.method}`));
  }

  request(method, params = {}, options = {}) {
    const id = `pond-proof-${this.nextId}`;
    this.nextId += 1;
    const timeoutMs = options.timeoutMs ?? 30_000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Gateway RPC timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        expectFinal: options.expectFinal === true,
        resolve,
        reject,
        timer,
      });
      this.ws.send(JSON.stringify({ type: "req", id, method, params }));
    });
  }

  close() {
    this.ws?.close();
  }
}

async function connectVerifier(url, token) {
  const rpc = new GatewayRpc({
    url,
    token,
    scopes: ["operator.read", "operator.write", "operator.pairing", "operator.admin"],
  });
  await rpc.connect();
  return rpc;
}

async function waitFor(label, timeoutMs, fn) {
  const deadline = now() + timeoutMs;
  let lastError;
  while (now() < deadline) {
    try {
      const value = await fn();
      if (value) {
        return value;
      }
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 500);
    });
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ""}`);
}

function connectedProofNodes(nodes) {
  return (nodes ?? []).filter(
    (node) =>
      Array.isArray(node.nodePluginTools) &&
      node.nodePluginTools.some((tool) => tool.pluginId === PLUGIN_ID && tool.name === "pond_echo"),
  );
}

function isPondPairingRequest(request) {
  const commands = Array.isArray(request?.commands) ? request.commands : [];
  const nodeId = typeof request?.nodeId === "string" ? request.nodeId : "";
  const displayName = typeof request?.displayName === "string" ? request.displayName : "";
  return (
    commands.includes("pond.echo") &&
    (nodeId.startsWith("pond-") || displayName.startsWith("Pond "))
  );
}

async function approvePendingNodes(rpc) {
  const list = await rpc.request("node.pair.list", {});
  const pending = Array.isArray(list?.pending) ? list.pending : [];
  for (const request of pending) {
    if (request?.requestId && isPondPairingRequest(request)) {
      await rpc.request("node.pair.approve", { requestId: request.requestId });
    }
  }
  return pending.filter(isPondPairingRequest).length;
}

async function waitForProofNodes(rpc, count) {
  let lastLogMs = 0;
  return await waitFor(`connected proof nodes >= ${count}`, 60_000, async () => {
    await approvePendingNodes(rpc);
    const result = await rpc.request("node.list", {});
    const nodes = connectedProofNodes(result?.nodes);
    if (verboseOutput && now() - lastLogMs > 5_000) {
      lastLogMs = now();
      console.error(
        "[pond-proof] node.list",
        JSON.stringify(
          (result?.nodes ?? []).map((node) => ({
            nodeId: node.nodeId,
            displayName: node.displayName,
            status: node.status,
            connected: node.connected,
            commands: node.commands,
            nodePluginTools: node.nodePluginTools,
            nodeSkills: node.nodeSkills,
          })),
        ),
      );
    }
    return nodes.length >= count ? nodes : null;
  });
}

function flattenEffectiveTools(result) {
  return (result?.groups ?? []).flatMap((group) =>
    (group.tools ?? []).map((tool) => Object.assign({}, tool, { groupId: group.id })),
  );
}

async function readEffectiveProofTools(rpc) {
  const result = await rpc.request("tools.effective", { sessionKey: SESSION_KEY });
  return flattenEffectiveTools(result).filter(
    (tool) =>
      tool.pluginId === PLUGIN_ID && (tool.id === "pond_echo" || tool.id.endsWith("_pond_echo")),
  );
}

async function readEffectiveMcpProofTools(rpc) {
  const result = await rpc.request("tools.effective", { sessionKey: SESSION_KEY });
  return flattenEffectiveTools(result).filter(
    (tool) => tool.pluginId === MCP_PLUGIN_ID && tool.id.startsWith("pond_"),
  );
}

async function readEffectiveSharedProofTools(rpc) {
  const result = await rpc.request("tools.effective", { sessionKey: SESSION_KEY });
  return flattenEffectiveTools(result).filter(
    (tool) => tool.pluginId === PLUGIN_ID && tool.id.endsWith(`_${SHARED_TOOL_NAME}`),
  );
}

async function readProofSkills(rpc) {
  const result = await rpc.request("skills.status", { agentId: "main" });
  const locatorSuffix = `/skills/${SKILL_NAME}/SKILL.md`;
  return (result?.skills ?? []).filter(
    (skill) =>
      skill.name === SKILL_NAME &&
      skill.source === "openclaw-node" &&
      skill.filePath.startsWith("node://") &&
      skill.filePath.endsWith(locatorSuffix),
  );
}

async function invokeProofTools(rpc, tools) {
  const outputs = [];
  for (const tool of tools) {
    const result = await rpc.request(
      "tools.invoke",
      {
        name: tool.id,
        sessionKey: SESSION_KEY,
        args: { message: `from-${tool.id}` },
        idempotencyKey: `pond-${tool.id}-${now()}`,
      },
      { timeoutMs: 45_000 },
    );
    if (!result?.ok) {
      throw new Error(`tools.invoke failed for ${tool.id}: ${JSON.stringify(result)}`);
    }
    outputs.push({ tool: tool.id, output: result.output?.details ?? result.output });
  }
  return outputs;
}

async function invokeMcpProofTool(rpc, tool, proof) {
  const result = await rpc.request(
    "tools.invoke",
    {
      name: tool.id,
      sessionKey: SESSION_KEY,
      args: { text: proof },
      idempotencyKey: `pond-mcp-${now()}`,
    },
    { timeoutMs: 45_000 },
  );
  if (!result?.ok) {
    throw new Error(`tools.invoke failed for ${tool.id}: ${JSON.stringify(result)}`);
  }
  const output = result.output?.details ?? result.output;
  const texts = (output?.content ?? [])
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text);
  if (!texts.some((text) => text.includes(proof))) {
    throw new Error(`MCP proof token missing from ${tool.id} output: ${JSON.stringify(output)}`);
  }
  return { tool: tool.id, output };
}

function assertToolIds(label, tools, expectedIds) {
  const actual = tools.map((tool) => tool.id).toSorted((a, b) => a.localeCompare(b));
  const expected = [...expectedIds].toSorted((a, b) => a.localeCompare(b));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: expected ${expected.join(", ")}, got ${actual.join(", ")}`);
  }
}

function expectedNodeToolId(nodeId, baseName) {
  let fragment = nodeId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
  fragment = fragment || "node";
  if (!/^[a-z]/.test(fragment)) {
    fragment = `node_${fragment}`.slice(0, 32);
  }
  return `${fragment}_${baseName}`;
}

async function runLiveAgentTurn(rpc, { label, message, sessionKey }) {
  const idempotencyKey = `pond-live-${label}-${crypto.randomBytes(8).toString("hex")}`;
  const payload = await rpc.request(
    "agent",
    {
      sessionKey,
      idempotencyKey,
      message,
      deliver: false,
      timeout: LIVE_TURN_TIMEOUT_MS / 1_000,
    },
    { expectFinal: true, timeoutMs: LIVE_TURN_TIMEOUT_MS },
  );
  if (payload?.status !== "ok") {
    throw new Error(`${label} agent turn failed: ${JSON.stringify(payload)}`);
  }
  const { extractAgentReplyTexts } = await import("./lib/agent-turn-output.mjs");
  const replies = extractAgentReplyTexts(JSON.stringify(payload));
  const reply = replies.join("\n").trim();
  if (!reply) {
    throw new Error(`${label} agent turn returned no assistant text: ${JSON.stringify(payload)}`);
  }
  return { reply, runId: payload.runId };
}

async function runLiveChecks({ rpc, mcpTool, mcpCallLogPath, nodes, skillMarker }) {
  if (!mcpTool || !mcpCallLogPath) {
    throw new Error("live MCP proof requires a published tool and call-log path");
  }
  const startedAt = now();
  logStep(`running live agent turns with ${LIVE_MODEL}`);

  const mcpToken = proofToken();
  const mcpTurn = await runLiveAgentTurn(rpc, {
    label: "mcp",
    sessionKey: "agent:main:pond-live-mcp",
    message: `Call the tool ${mcpTool.id} with text ${JSON.stringify(mcpToken)}. Reply with exactly the text the tool returned. Do not call any other tool.`,
  });
  if (!mcpTurn.reply.includes(mcpToken)) {
    throw new Error(`live MCP reply missing ${mcpToken}: ${JSON.stringify(mcpTurn.reply)}`);
  }
  await waitFor("live MCP fixture call log", 10_000, async () => {
    try {
      return (await fs.readFile(mcpCallLogPath, "utf8")).includes(mcpToken);
    } catch {
      return false;
    }
  });

  const skillTurn = await runLiveAgentTurn(rpc, {
    label: "skill",
    sessionKey: "agent:main:pond-live-skill",
    message: `What is the pond marker? Follow the ${SKILL_NAME} skill. Reply with exactly the marker and nothing else.`,
  });
  if (!skillTurn.reply.includes(skillMarker)) {
    throw new Error(`live skill reply missing ${skillMarker}: ${JSON.stringify(skillTurn.reply)}`);
  }

  const sharedTools = await waitFor("two disambiguated shared proof tools", 30_000, async () => {
    const tools = await readEffectiveSharedProofTools(rpc);
    return tools.length === 2 ? tools : null;
  });
  const pondANode = nodes.find((node) => node.displayName === "Pond A");
  const pondBNode = nodes.find((node) => node.displayName === "Pond B");
  if (!pondANode?.nodeId || !pondBNode?.nodeId) {
    throw new Error(
      `live shared-tool proof could not resolve Pond A/B nodes: ${JSON.stringify(nodes)}`,
    );
  }
  const expectedSharedIds = [
    expectedNodeToolId(pondANode.nodeId, SHARED_TOOL_NAME),
    expectedNodeToolId(pondBNode.nodeId, SHARED_TOOL_NAME),
  ];
  assertToolIds("shared proof tool names", sharedTools, expectedSharedIds);
  const pondBTool = sharedTools.find((tool) => tool.id === expectedSharedIds[1]);
  if (!pondBTool) {
    throw new Error("pond-b shared proof tool missing after deterministic-name assertion");
  }
  const sharedTurn = await runLiveAgentTurn(rpc, {
    label: "shared",
    sessionKey: "agent:main:pond-live-shared",
    message: `Call the tool ${pondBTool.id} with no arguments. Reply with exactly its output. Do not call any other tool.`,
  });
  const sharedMarker = "pond-b-shared-ok";
  if (!sharedTurn.reply.includes(sharedMarker)) {
    throw new Error(
      `live shared-tool reply missing ${sharedMarker}: ${JSON.stringify(sharedTurn.reply)}`,
    );
  }

  return {
    model: LIVE_MODEL,
    durationMs: now() - startedAt,
    mcp: { tool: mcpTool.id, runId: mcpTurn.runId, proofToken: mcpToken },
    skill: { name: SKILL_NAME, runId: skillTurn.runId, marker: skillMarker },
    shared: { tools: sharedTools, selected: pondBTool.id, runId: sharedTurn.runId, sharedMarker },
  };
}

async function runVerify({ url, token, expectedNodes }) {
  const rpc = await connectVerifier(url, token);
  try {
    const nodes = await waitForProofNodes(rpc, expectedNodes);
    const tools = await waitFor(`effective proof tools >= ${expectedNodes}`, 30_000, async () => {
      const value = await readEffectiveProofTools(rpc);
      return value.length >= expectedNodes ? value : null;
    });
    const outputs = await invokeProofTools(rpc, tools);
    const labels = new Set(outputs.map((entry) => entry.output?.nodeLabel).filter(Boolean));
    if (labels.size < expectedNodes) {
      throw new Error(`expected ${expectedNodes} node labels, got ${[...labels].join(",")}`);
    }
    console.log(
      JSON.stringify(
        {
          ok: true,
          nodes: nodes.map((node) => ({
            nodeId: node.nodeId,
            displayName: node.displayName,
            tools: node.nodePluginTools,
          })),
          effectiveTools: tools,
          outputs,
        },
        null,
        2,
      ),
    );
  } finally {
    rpc.close();
  }
}

async function runGateway(args) {
  const token = String(args.token || process.env.OPENCLAW_GATEWAY_TOKEN || "");
  if (!token) {
    throw new Error("--token or OPENCLAW_GATEWAY_TOKEN required");
  }
  const port = Number(args.port || DEFAULT_PORT);
  const baseDir = String(
    args.baseDir || (await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-node-plugin-tools-"))),
  );
  const state = await prepareRoleState(baseDir, "gateway", token, "gateway");
  console.log(JSON.stringify({ role: "gateway", port, tokenSet: true, stateDir: state.stateDir }));
  const child = spawnOpenClaw(
    [
      "gateway",
      "run",
      "--allow-unconfigured",
      "--auth",
      "token",
      "--bind",
      "lan",
      "--port",
      String(port),
      "--ws-log",
      "compact",
    ],
    { env: childEnv(state, token, "gateway") },
  );
  await runForegroundChild(child);
}

async function runNode(args) {
  const token = String(args.token || process.env.OPENCLAW_GATEWAY_TOKEN || "");
  if (!token) {
    throw new Error("--token or OPENCLAW_GATEWAY_TOKEN required");
  }
  const host = String(args.host || "127.0.0.1");
  const port = Number(args.port || DEFAULT_PORT);
  const nodeId = String(args.nodeId || `pond-${crypto.randomBytes(4).toString("hex")}`);
  const displayName = String(args.displayName || nodeId);
  const baseDir = String(
    args.baseDir || (await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-node-plugin-tools-"))),
  );
  const state = await prepareRoleState(baseDir, nodeId, token, nodeId, {
    nodeSurfaces: args["plugin-only"] !== true,
    skillProofToken: String(args.skillProofToken || proofToken()),
  });
  console.log(JSON.stringify({ role: "node", nodeId, host, port, tokenSet: true }));
  const child = spawnOpenClaw(
    [
      "node",
      "run",
      "--host",
      host,
      "--port",
      String(port),
      "--node-id",
      nodeId,
      "--display-name",
      displayName,
    ],
    { env: childEnv(state, token, nodeId) },
  );
  if (args.lifetimeMs) {
    setTimeout(() => {
      child.kill("SIGTERM");
    }, Number(args.lifetimeMs));
  }
  await runForegroundChild(child);
}

async function runLocal(args) {
  const live = args.live === true;
  const token = String(args.token || proofToken());
  const mcpProofToken = proofToken();
  const skillProofToken = proofToken();
  const port = args.port ? Number(args.port) : await availableLoopbackPort();
  const baseDir = String(
    args.baseDir || (await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-node-plugin-tools-"))),
  );
  const gatewayState = await prepareRoleState(baseDir, "gateway", token, "gateway", {
    liveModel: live ? LIVE_MODEL : undefined,
    sharedTool: live,
  });
  const nodeAState = await prepareRoleState(baseDir, "pond-a", token, "pond-a", {
    sharedTool: live,
  });
  const nodeBState = await prepareRoleState(baseDir, "pond-b", token, "pond-b", {
    nodeSurfaces: true,
    sharedTool: live,
    skillProofToken,
  });
  const children = [];
  if (args.build === true) {
    logStep("building OpenClaw");
    await runCommand("pnpm", ["build"], {
      stdio: args.verbose ? "inherit" : ["ignore", "ignore", "ignore"],
    });
  } else {
    logStep("using existing OpenClaw build (pass --build to rebuild)");
  }
  const childOptions = (state, label) => ({
    env: childEnv(state, token, label),
    stdio: args.verbose ? "inherit" : ["ignore", "ignore", "ignore"],
    built: true,
    onExit: (code, signal) => {
      if (args.verbose) {
        console.error(`[${label}] exit code=${code} signal=${signal}`);
      }
    },
  });
  try {
    logStep("starting gateway");
    children.push(
      spawnOpenClaw(
        [
          "gateway",
          "run",
          "--allow-unconfigured",
          "--auth",
          "token",
          "--bind",
          "loopback",
          "--port",
          String(port),
          "--ws-log",
          "compact",
        ],
        childOptions(gatewayState, "gateway"),
      ),
    );
    const url = `ws://127.0.0.1:${port}`;
    await waitFor("gateway RPC", 60_000, async () => {
      const rpc = await connectVerifier(url, token);
      rpc.close();
      return true;
    });
    logStep("starting pond-a and pond-b node hosts");
    children.push(
      spawnOpenClaw(
        [
          "node",
          "run",
          "--host",
          "127.0.0.1",
          "--port",
          String(port),
          "--node-id",
          "pond-a",
          "--display-name",
          "Pond A",
        ],
        childOptions(nodeAState, "pond-a"),
      ),
    );
    children.push(
      spawnOpenClaw(
        [
          "node",
          "run",
          "--host",
          "127.0.0.1",
          "--port",
          String(port),
          "--node-id",
          "pond-b",
          "--display-name",
          "Pond B",
        ],
        childOptions(nodeBState, "pond-b"),
      ),
    );
    const rpc = await connectVerifier(url, token);
    try {
      logStep("waiting for node plugin tools, MCP tool, and node skill publication");
      await waitForProofNodes(rpc, 2);
      const initialTools = await waitFor("two effective proof tools", 30_000, async () => {
        const tools = await readEffectiveProofTools(rpc);
        return tools.length === 2 ? tools : null;
      });
      const initialOutputs = await invokeProofTools(rpc, initialTools);
      const initialMcpTools = await waitFor("one effective MCP proof tool", 30_000, async () => {
        const tools = await readEffectiveMcpProofTools(rpc);
        return tools.length === 1 ? tools : null;
      });
      const initialMcpOutput = await invokeMcpProofTool(rpc, initialMcpTools[0], mcpProofToken);
      const initialSkills = await waitFor("node skill in skills.status", 30_000, async () => {
        const skills = await readProofSkills(rpc);
        return skills.length === 1 ? skills : null;
      });
      if (!(await fs.readFile(nodeBState.skillPath, "utf8")).includes(skillProofToken)) {
        throw new Error("node skill fixture proof token missing before publication assertion");
      }
      logStep("stopping pond-b and verifying all three published surfaces disappear");
      await terminate(children.pop());
      await waitFor("pond-b offline", 30_000, async () => {
        const result = await rpc.request("node.list", {});
        return connectedProofNodes(result?.nodes).length === 1;
      });
      const afterOfflineTools = await waitFor(
        "one effective proof tool after offline",
        30_000,
        async () => {
          const tools = await readEffectiveProofTools(rpc);
          return tools.length === 1 ? tools : null;
        },
      );
      await waitFor("MCP proof tool removed after offline", 30_000, async () => {
        const tools = await readEffectiveMcpProofTools(rpc);
        return tools.length === 0;
      });
      await waitFor("node skill removed after offline", 30_000, async () => {
        const skills = await readProofSkills(rpc);
        return skills.length === 0;
      });
      logStep("restarting pond-b and verifying publication returns");
      const restartedB = spawnOpenClaw(
        [
          "node",
          "run",
          "--host",
          "127.0.0.1",
          "--port",
          String(port),
          "--node-id",
          "pond-b",
          "--display-name",
          "Pond B",
        ],
        childOptions(nodeBState, "pond-b-restart"),
      );
      children.push(restartedB);
      const reconnectedNodes = await waitForProofNodes(rpc, 2);
      const afterReconnectTools = await waitFor(
        "two effective proof tools after reconnect",
        30_000,
        async () => {
          const tools = await readEffectiveProofTools(rpc);
          return tools.length === 2 ? tools : null;
        },
      );
      const afterReconnectOutputs = await invokeProofTools(rpc, afterReconnectTools);
      const afterReconnectMcpTools = await waitFor(
        "MCP proof tool after reconnect",
        30_000,
        async () => {
          const tools = await readEffectiveMcpProofTools(rpc);
          return tools.length === 1 ? tools : null;
        },
      );
      const afterReconnectMcpOutput = await invokeMcpProofTool(
        rpc,
        afterReconnectMcpTools[0],
        mcpProofToken,
      );
      const afterReconnectSkills = await waitFor("node skill after reconnect", 30_000, async () => {
        const skills = await readProofSkills(rpc);
        return skills.length === 1 ? skills : null;
      });
      const liveResult = live
        ? await runLiveChecks({
            rpc,
            mcpTool: afterReconnectMcpTools[0],
            mcpCallLogPath: nodeBState.mcpCallLogPath,
            nodes: reconnectedNodes,
            skillMarker: skillProofToken,
          })
        : undefined;
      logStep("all node-hosted surface checks passed");
      console.log(
        JSON.stringify(
          {
            ok: true,
            provider: "local-process",
            baseDir,
            initialTools,
            initialOutputs,
            initialMcpTools,
            initialMcpOutput,
            initialSkills,
            afterOfflineTools,
            afterReconnectTools,
            afterReconnectOutputs,
            afterReconnectMcpTools,
            afterReconnectMcpOutput,
            afterReconnectSkills,
            ...(liveResult ? { live: liveResult } : {}),
          },
          null,
          2,
        ),
      );
    } finally {
      rpc.close();
    }
  } finally {
    await Promise.all(children.map((child) => terminate(child)));
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  verboseOutput = args.verbose === true;
  const mode = args._[0] ?? "local";
  if (args.live === true && !process.env.ANTHROPIC_API_KEY?.trim()) {
    console.error("--live requires ANTHROPIC_API_KEY");
    process.exitCode = 2;
    return;
  }
  if (mode === "gateway") {
    await runGateway(args);
    return;
  }
  if (mode === "node") {
    await runNode(args);
    return;
  }
  if (mode === "verify") {
    const token = String(args.token || process.env.OPENCLAW_GATEWAY_TOKEN || "");
    if (!token) {
      throw new Error("--token or OPENCLAW_GATEWAY_TOKEN required");
    }
    await runVerify({
      url: String(args.url || `ws://127.0.0.1:${args.port || DEFAULT_PORT}`),
      token,
      expectedNodes: Number(args.expectedNodes || 2),
    });
    return;
  }
  if (mode === "local") {
    await runLocal(args);
    return;
  }
  throw new Error(
    "usage: node scripts/e2e/node-plugin-tools-pond.mjs [local|gateway|node|verify] [--build] [--live]",
  );
}

main().catch(
  /** @param {unknown} err */ (err) => {
    console.error(err instanceof Error ? err.stack || err.message : String(err));
    process.exitCode = 1;
  },
);
