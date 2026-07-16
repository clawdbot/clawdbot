#!/usr/bin/env node
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { PondGatewayRpc } from "./lib/pond-gateway-rpc.mjs";

const DEFAULT_PORT = 18789;
const SESSION_KEY = "agent:main:main";
const PLUGIN_ID = "pond-node-tools";
const MCP_PLUGIN_ID = "node-mcp";
const MCP_SERVER_NAME = "pond";
const MCP_TOOL_NAME = "pond_echo";
const MCP_SLOW_TOOL_NAME = "pond_slow";
const FILESYSTEM_MCP_SERVER_NAME = "filesystem";
const FILESYSTEM_MCP_TOOL_NAME = "filesystem_read_text_file";
const FILESYSTEM_MCP_PACKAGE = "@modelcontextprotocol/server-filesystem@2026.7.4";
const SHARED_TOOL_NAME = "pond_shared_probe";
const SKILL_NAME = "pond-node-skill";
const DEFAULT_LIVE_MODEL = "anthropic/claude-sonnet-4-6";
const DEFAULT_HOT_PLUG_LIVE_MODEL = "openai/gpt-5.4";
const LIVE_TURN_TIMEOUT_MS = 120_000;
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
    server.close((error) => {
      if (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      resolve();
    });
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
  const slowCallLogPath = path.join(rootDir, "mcp", "slow-calls.jsonl");
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
const slowCallLogPath = ${JSON.stringify(slowCallLogPath)};
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

server.tool(
  ${JSON.stringify(MCP_SLOW_TOOL_NAME)},
  "Return a pond proof payload after a deliberate ten-second delay.",
  { text: z.string() },
  async ({ text }) => {
    await appendFile(slowCallLogPath, JSON.stringify({ phase: "started", text }) + "\\n", "utf8");
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    await appendFile(slowCallLogPath, JSON.stringify({ phase: "finished", text }) + "\\n", "utf8");
    return {
      content: [{ type: "text", text: JSON.stringify({ text }) }],
    };
  },
);

await server.connect(new StdioServerTransport());
`;
  await fs.writeFile(serverPath, source, { encoding: "utf8", mode: 0o755 });
  return { callLogPath, serverPath, slowCallLogPath };
}

async function writeProofSkill(stateDir, proof) {
  const skillPath = path.join(stateDir, "skills", SKILL_NAME, "SKILL.md");
  const content = `---\nname: ${SKILL_NAME}\ndescription: Pond node-hosted skill proof\n---\n\n# Pond node skill\n\nWhen asked for the pond marker, reply with exactly ${proof}.\n`;
  await fs.mkdir(path.dirname(skillPath), { recursive: true });
  await fs.writeFile(skillPath, content, "utf8");
  return skillPath;
}

async function writeRemoteExecProofSkill(stateDir, proofFilePath, skillName) {
  const skillPath = path.join(stateDir, "skills", skillName, "SKILL.md");
  const content = `---\nname: ${skillName}\ndescription: Read the pond node-local proof file\n---\n\n# Pond node skill\n\nWhen asked for the pond node-local marker, use the exec tool with host=node to run:\n\n\`\`\`sh\ncat ${JSON.stringify(proofFilePath)}\n\`\`\`\n\nReply with exactly the command output. Never infer or repeat a marker from this skill body.\n`;
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
                models: { [options.liveModel]: { params: { fastMode: true } } },
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
                    // Keep the baseline surface singular; the hot-plug scenario owns the slow tool.
                    toolFilter: { include: [MCP_TOOL_NAME] },
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
    mcpSlowCallLogPath: mcpFixture?.slowCallLogPath,
    skillPath,
  };
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function enableHotPlugNodeSurfaces(state, { mcpProofToken, skillProofToken, skillName }) {
  const mcpProofDir = path.join(state.rootDir, "mcp-proof");
  const mcpProofFilePath = path.join(mcpProofDir, "proof.txt");
  const skillProofDir = path.join(state.rootDir, "skill-proof");
  const skillProofFilePath = path.join(skillProofDir, "proof.txt");
  await fs.mkdir(mcpProofDir, { recursive: true });
  await fs.mkdir(skillProofDir, { recursive: true });
  await fs.writeFile(mcpProofFilePath, `${mcpProofToken}\n`, "utf8");
  await fs.writeFile(skillProofFilePath, `${skillProofToken}\n`, "utf8");
  const mcpFixture = await writeProofMcpServer(state.rootDir);
  const skillPath = await writeRemoteExecProofSkill(state.stateDir, skillProofFilePath, skillName);
  const config = await readJson(state.configPath);
  const filesystemCommand = process.platform === "win32" ? "cmd" : "npx";
  const filesystemArgs = [
    ...(process.platform === "win32" ? ["/c", "npx"] : []),
    "-y",
    FILESYSTEM_MCP_PACKAGE,
    mcpProofDir,
  ];
  config.nodeHost = {
    mcp: {
      servers: {
        [FILESYSTEM_MCP_SERVER_NAME]: {
          command: filesystemCommand,
          args: filesystemArgs,
          transport: "stdio",
          toolFilter: { include: ["read_text_file"] },
        },
        [MCP_SERVER_NAME]: {
          command: process.execPath,
          args: [mcpFixture.serverPath],
          transport: "stdio",
          toolFilter: { include: [MCP_SLOW_TOOL_NAME] },
        },
      },
    },
    skills: { enabled: true },
  };
  await writeJson(state.configPath, config, { mode: 0o600 });
  return {
    ...mcpFixture,
    mcpProofDir,
    mcpProofFilePath,
    skillProofFilePath,
    skillPath,
  };
}

async function disableHotPlugNodeSurfaces(state, skillName = SKILL_NAME) {
  const config = await readJson(state.configPath);
  delete config.nodeHost;
  await writeJson(state.configPath, config, { mode: 0o600 });
  await fs.rm(path.join(state.stateDir, "skills", skillName), {
    force: true,
    recursive: true,
  });
}

function childEnv(state, token, nodeLabel) {
  return {
    ...process.env,
    ...(process.env.OPENAI_API_KEY
      ? {}
      : process.env.OPENCLAW_LIVE_OPENAI_KEY
        ? { OPENAI_API_KEY: process.env.OPENCLAW_LIVE_OPENAI_KEY }
        : {}),
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

async function connectVerifier(url, token) {
  const rpc = new PondGatewayRpc({
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

async function waitForProofNodes(rpc, count, options = {}) {
  let lastLogMs = 0;
  return await waitFor(`connected proof nodes >= ${count}`, 60_000, async () => {
    if (options.approve !== false) {
      await approvePendingNodes(rpc);
    }
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

async function readPondPairingState(rpc, nodeId) {
  const [deviceList, nodeList] = await Promise.all([
    rpc.request("device.pair.list", {}),
    rpc.request("node.pair.list", {}),
  ]);
  const pending = (Array.isArray(nodeList?.pending) ? nodeList.pending : []).filter(
    (entry) => entry?.nodeId === nodeId,
  );
  const paired = (Array.isArray(deviceList?.paired) ? deviceList.paired : []).filter(
    (entry) => entry?.deviceId === nodeId,
  );
  return { paired, pending };
}

function assertPairingDidNotChange(before, after) {
  if (before.paired.length !== 1 || after.paired.length !== 1) {
    throw new Error(
      `expected one durable pond pairing before/after restart: ${JSON.stringify({ before, after })}`,
    );
  }
  if (after.pending.length !== 0) {
    throw new Error(`hot-plug created a new pairing prompt: ${JSON.stringify(after.pending)}`);
  }
  if (before.paired[0]?.deviceId !== after.paired[0]?.deviceId) {
    throw new Error(`hot-plug changed paired node identity: ${JSON.stringify({ before, after })}`);
  }
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

async function readEffectiveToolById(rpc, toolId) {
  const result = await rpc.request("tools.effective", { sessionKey: SESSION_KEY });
  return flattenEffectiveTools(result).find((tool) => tool.id === toolId);
}

async function readEffectiveSharedProofTools(rpc) {
  const result = await rpc.request("tools.effective", { sessionKey: SESSION_KEY });
  return flattenEffectiveTools(result).filter(
    (tool) => tool.pluginId === PLUGIN_ID && tool.id.endsWith(`_${SHARED_TOOL_NAME}`),
  );
}

async function readProofSkills(rpc, skillName = SKILL_NAME) {
  const result = await rpc.request("skills.status", { agentId: "main" });
  const locatorSuffix = `/skills/${skillName}/SKILL.md`;
  return (result?.skills ?? []).filter(
    (skill) =>
      skill.name === skillName &&
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
  const replies = [
    ...new Set(
      extractAgentReplyTexts(JSON.stringify(payload))
        .map((reply) => reply.trim())
        .filter(Boolean),
    ),
  ];
  const reply = replies.join("\n").trim();
  if (!reply) {
    throw new Error(`${label} agent turn returned no assistant text: ${JSON.stringify(payload)}`);
  }
  return { reply, runId: payload.runId };
}

async function readSessionToolCalls(rpc, sessionKey) {
  const history = await rpc.request("chat.history", { sessionKey, limit: 64 });
  return (history?.messages ?? []).flatMap((message) => {
    if (message?.role !== "assistant" || !Array.isArray(message.content)) {
      return [];
    }
    return message.content.filter(
      (block) => block?.type === "toolCall" && typeof block.name === "string",
    );
  });
}

async function assertSessionUsedTool(rpc, sessionKey, toolName, argumentsMatch) {
  const calls = await readSessionToolCalls(rpc, sessionKey);
  const matching = calls.find(
    (call) => call.name === toolName && (!argumentsMatch || argumentsMatch(call.arguments)),
  );
  if (!matching) {
    throw new Error(`session ${sessionKey} did not call ${toolName}: ${JSON.stringify(calls)}`);
  }
  return matching;
}

async function assertSessionUsedNodeExec(rpc, sessionKey, nodeId, commandPath) {
  const calls = await readSessionToolCalls(rpc, sessionKey);
  const matching = calls.find((call) => {
    const args = call.arguments;
    if (call.name === "node_exec") {
      return (
        (!args?.node || args.node === nodeId) && String(args?.command ?? "").includes(commandPath)
      );
    }
    return (
      call.name === "exec" &&
      args?.host === "node" &&
      (!args.node || args.node === nodeId) &&
      String(args?.command ?? "").includes(commandPath)
    );
  });
  if (!matching) {
    throw new Error(
      `session ${sessionKey} did not execute on node ${nodeId}: ${JSON.stringify(calls)}`,
    );
  }
  return matching;
}

async function runLiveChecks({ rpc, mcpTool, mcpCallLogPath, nodes, skillMarker, liveModel }) {
  if (!mcpTool || !mcpCallLogPath) {
    throw new Error("live MCP proof requires a published tool and call-log path");
  }
  const startedAt = now();
  logStep(`running live agent turns with ${liveModel}`);

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
    model: liveModel,
    durationMs: now() - startedAt,
    mcp: { tool: mcpTool.id, runId: mcpTurn.runId, proofToken: mcpToken },
    skill: { name: SKILL_NAME, runId: skillTurn.runId, marker: skillMarker },
    shared: { tools: sharedTools, selected: pondBTool.id, runId: sharedTurn.runId, sharedMarker },
  };
}

function pondNodeArgs(port) {
  return [
    "node",
    "run",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--node-id",
    "pond-hot-plug",
    "--display-name",
    "Pond Hot Plug",
  ];
}

async function runHotPlugLocal(args) {
  if (args.live !== true) {
    throw new Error("--hot-plug requires --live");
  }
  const liveModel = String(
    args.model || process.env.OPENCLAW_POND_LIVE_MODEL || DEFAULT_HOT_PLUG_LIVE_MODEL,
  );
  const token = String(args.token || proofToken());
  const mcpProofToken = proofToken();
  const skillProofToken = proofToken();
  const hotPlugSkillName = `${SKILL_NAME}-${skillProofToken.slice(-8)}`;
  const port = args.port ? Number(args.port) : await availableLoopbackPort();
  const baseDir = String(
    args.baseDir || (await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-node-hot-plug-"))),
  );
  const gatewayState = await prepareRoleState(baseDir, "gateway", token, "gateway", {
    liveModel,
  });
  const nodeState = await prepareRoleState(baseDir, "pond-hot-plug", token, "pond-hot-plug");
  const children = [];
  let nodeChild;
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
  const startNode = (label) => {
    const options = childOptions(nodeState, label);
    options.env = {
      ...options.env,
      HOME: nodeState.rootDir,
      npm_config_cache: process.env.npm_config_cache || path.join(os.homedir(), ".npm"),
    };
    nodeChild = spawnOpenClaw(pondNodeArgs(port), options);
    children.push(nodeChild);
    return nodeChild;
  };
  const stopNode = async () => {
    const child = nodeChild;
    nodeChild = undefined;
    if (!child) {
      return;
    }
    const index = children.indexOf(child);
    if (index >= 0) {
      children.splice(index, 1);
    }
    await terminate(child);
  };
  try {
    logStep("starting cold gateway and node host with no MCP servers or skills");
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
    startNode("pond-hot-plug-cold");
    const rpc = await connectVerifier(url, token);
    try {
      const coldNodes = await waitForProofNodes(rpc, 1);
      const pairedNodeId = coldNodes[0]?.nodeId;
      if (!pairedNodeId) {
        throw new Error(`cold node identity missing: ${JSON.stringify(coldNodes)}`);
      }
      const coldPairing = await readPondPairingState(rpc, pairedNodeId);
      if (coldPairing.paired.length !== 1 || coldPairing.pending.length !== 0) {
        throw new Error(`cold pairing did not settle: ${JSON.stringify(coldPairing)}`);
      }
      if ((await readEffectiveMcpProofTools(rpc)).length !== 0) {
        throw new Error("cold node unexpectedly published MCP tools");
      }
      if ((await readProofSkills(rpc, hotPlugSkillName)).length !== 0) {
        throw new Error("cold node unexpectedly published skills");
      }
      const coldSessionKey = "agent:main:pond-hot-plug-cold";
      const coldTurn = await runLiveAgentTurn(rpc, {
        label: "hot-plug-cold",
        sessionKey: coldSessionKey,
        message: `Inspect your actual tool inventory. If ${FILESYSTEM_MCP_TOOL_NAME} is available, reply exactly MCP_PRESENT. Otherwise reply exactly MCP_ABSENT. Do not call any tool.`,
      });
      if (coldTurn.reply.trim() !== "MCP_ABSENT") {
        throw new Error(`cold live turn hallucinated MCP availability: ${coldTurn.reply}`);
      }

      logStep("adding filesystem MCP, slow MCP, and node skill; restarting node host only");
      const surfaces = await enableHotPlugNodeSurfaces(nodeState, {
        mcpProofToken,
        skillProofToken,
        skillName: hotPlugSkillName,
      });
      await stopNode();
      startNode("pond-hot-plug-added");
      await waitForProofNodes(rpc, 1, { approve: false });
      const addedPairing = await readPondPairingState(rpc, pairedNodeId);
      assertPairingDidNotChange(coldPairing, addedPairing);
      const filesystemTool = await waitFor(
        "filesystem MCP tool after hot-plug",
        60_000,
        async () => await readEffectiveToolById(rpc, FILESYSTEM_MCP_TOOL_NAME),
      );
      const slowTool = await waitFor(
        "slow MCP tool after hot-plug",
        30_000,
        async () => await readEffectiveToolById(rpc, `${MCP_SERVER_NAME}_${MCP_SLOW_TOOL_NAME}`),
      );
      await waitFor("node skill after hot-plug", 30_000, async () => {
        const skills = await readProofSkills(rpc, hotPlugSkillName);
        return skills.length === 1 ? skills : null;
      });

      logStep("asking the live model to read the node-local file through filesystem MCP");
      let mcpTurn;
      let mcpSessionKey;
      let mcpAttempts = 0;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        mcpAttempts = attempt;
        mcpSessionKey = `agent:main:pond-hot-plug-mcp-${attempt}`;
        mcpTurn = await runLiveAgentTurn(rpc, {
          label: `hot-plug-filesystem-${attempt}`,
          sessionKey: mcpSessionKey,
          message: `You have the ${filesystemTool.id} tool. Call it now with path ${JSON.stringify(surfaces.mcpProofFilePath)}. Reply with exactly the file contents and nothing else. Do not call any other tool.`,
        });
        const calls = await readSessionToolCalls(rpc, mcpSessionKey);
        if (
          mcpTurn.reply.includes(mcpProofToken) &&
          calls.some((call) => call.name === filesystemTool.id)
        ) {
          break;
        }
        if (attempt === 1) {
          logStep(`filesystem live turn did not call the tool; retrying once: ${mcpTurn.reply}`);
        }
      }
      if (!mcpTurn?.reply.includes(mcpProofToken) || !mcpSessionKey) {
        throw new Error(`hot-plug filesystem reply missing node token: ${mcpTurn?.reply ?? ""}`);
      }
      await assertSessionUsedTool(rpc, mcpSessionKey, filesystemTool.id);

      logStep("asking the live model to follow the node-hosted remote-exec skill");
      const skillSessionKey = "agent:main:pond-hot-plug-skill";
      const skillTurn = await runLiveAgentTurn(rpc, {
        label: "hot-plug-skill",
        sessionKey: skillSessionKey,
        message: `Use the ${hotPlugSkillName} skill to get the pond node-local marker. Reply with exactly the marker.`,
      });
      if (!skillTurn.reply.includes(skillProofToken)) {
        throw new Error(`hot-plug skill reply missing node token: ${skillTurn.reply}`);
      }
      await assertSessionUsedNodeExec(
        rpc,
        skillSessionKey,
        pairedNodeId,
        surfaces.skillProofFilePath,
      );

      logStep(
        "starting slow MCP call, killing node host after server dispatch, and waiting for degradation",
      );
      let chaosToken;
      let chaosTurn;
      let chaosDurationMs;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        chaosToken = proofToken();
        const chaosSessionKey = `agent:main:pond-hot-plug-chaos-${attempt}`;
        const chaosStartedAt = now();
        const chaosTurnPromise = runLiveAgentTurn(rpc, {
          label: `hot-plug-chaos-${attempt}`,
          sessionKey: chaosSessionKey,
          message: `Mandatory tool execution test: call ${slowTool.id} now with text ${JSON.stringify(chaosToken)}. Do not reply before this tool call returns. After the call, reply exactly DEGRADED if it returned an error, otherwise reply exactly SUCCESS. A reply without the tool call is invalid. Do not call any other tool.`,
        });
        const dispatchPromise = waitFor("slow MCP call started", 60_000, async () => {
          try {
            return (await fs.readFile(surfaces.slowCallLogPath, "utf8")).includes(chaosToken);
          } catch {
            return false;
          }
        }).then(
          () => ({ dispatched: true }),
          () => ({ dispatched: false }),
        );
        const first = await Promise.race([
          dispatchPromise,
          chaosTurnPromise.then((turn) => ({ dispatched: false, turn })),
        ]);
        if (!first.dispatched) {
          const turn = "turn" in first ? first.turn : await chaosTurnPromise;
          if (attempt === 2) {
            throw new Error(`live model did not dispatch ${slowTool.id}: ${turn.reply}`);
          }
          logStep(`slow MCP live turn did not call the tool; retrying once: ${turn.reply}`);
          continue;
        }
        await new Promise((resolve) => {
          setTimeout(resolve, 3_000);
        });
        await stopNode();
        chaosTurn = await chaosTurnPromise;
        chaosDurationMs = now() - chaosStartedAt;
        break;
      }
      if (!chaosTurn || chaosTurn.reply.trim() !== "DEGRADED") {
        throw new Error(`mid-turn node loss did not degrade cleanly: ${chaosTurn?.reply ?? ""}`);
      }

      logStep("reconnecting node host and retrying the slow MCP call");
      startNode("pond-hot-plug-retry");
      await waitForProofNodes(rpc, 1, { approve: false });
      assertPairingDidNotChange(coldPairing, await readPondPairingState(rpc, pairedNodeId));
      const retrySlowTool = await waitFor(
        "slow MCP tool after reconnect",
        30_000,
        async () => await readEffectiveToolById(rpc, slowTool.id),
      );
      const retryToken = proofToken();
      const retrySessionKey = "agent:main:pond-hot-plug-retry";
      const retryTurn = await runLiveAgentTurn(rpc, {
        label: "hot-plug-retry",
        sessionKey: retrySessionKey,
        message: `Call ${retrySlowTool.id} with text ${JSON.stringify(retryToken)}. Reply with exactly the returned text and nothing else. Do not call any other tool.`,
      });
      if (!retryTurn.reply.includes(retryToken)) {
        throw new Error(`retry reply missing MCP token: ${retryTurn.reply}`);
      }
      await assertSessionUsedTool(rpc, retrySessionKey, retrySlowTool.id);

      logStep("removing MCP servers and skill; restarting node host and checking symmetry");
      await disableHotPlugNodeSurfaces(nodeState, hotPlugSkillName);
      await stopNode();
      startNode("pond-hot-plug-removed");
      await waitForProofNodes(rpc, 1, { approve: false });
      const removedPairing = await readPondPairingState(rpc, pairedNodeId);
      assertPairingDidNotChange(coldPairing, removedPairing);
      await waitFor("all MCP tools removed", 30_000, async () => {
        const filesystem = await readEffectiveToolById(rpc, filesystemTool.id);
        const slow = await readEffectiveToolById(rpc, slowTool.id);
        return !filesystem && !slow;
      });
      await waitFor(
        "node skill removed",
        30_000,
        async () => (await readProofSkills(rpc, hotPlugSkillName)).length === 0,
      );
      const removedTurn = await runLiveAgentTurn(rpc, {
        label: "hot-plug-removed",
        sessionKey: "agent:main:pond-hot-plug-removed",
        message: `Inspect your actual tools and skills. Reply exactly MCP_ABSENT|SKILL_ABSENT if ${filesystemTool.id} and ${hotPlugSkillName} are both unavailable. Do not call any tool.`,
      });
      if (removedTurn.reply.trim() !== "MCP_ABSENT|SKILL_ABSENT") {
        throw new Error(`removal live turn retained stale surfaces: ${removedTurn.reply}`);
      }

      logStep("hot-plug tour passed");
      console.log(
        JSON.stringify(
          {
            ok: true,
            scenario: "hot-plug-tour",
            provider: "local-process",
            model: liveModel,
            baseDir,
            pairing: {
              nodeId: coldPairing.paired[0]?.deviceId,
              approvedCommands: coldPairing.paired[0]?.nodeSurface?.commands,
              pendingAfterAdd: addedPairing.pending.length,
              pendingAfterRemove: removedPairing.pending.length,
            },
            cold: { runId: coldTurn.runId, reply: coldTurn.reply },
            mcp: {
              tool: filesystemTool.id,
              runId: mcpTurn.runId,
              marker: mcpProofToken,
              attempts: mcpAttempts,
            },
            skill: { name: hotPlugSkillName, runId: skillTurn.runId, marker: skillProofToken },
            chaos: {
              tool: slowTool.id,
              runId: chaosTurn.runId,
              reply: chaosTurn.reply,
              durationMs: chaosDurationMs,
            },
            retry: { runId: retryTurn.runId, marker: retryToken },
            removed: { runId: removedTurn.runId, reply: removedTurn.reply },
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
  const liveModel = String(
    args.model || process.env.OPENCLAW_POND_LIVE_MODEL || DEFAULT_LIVE_MODEL,
  );
  const token = String(args.token || proofToken());
  const mcpProofToken = proofToken();
  const skillProofToken = proofToken();
  const port = args.port ? Number(args.port) : await availableLoopbackPort();
  const baseDir = String(
    args.baseDir || (await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-node-plugin-tools-"))),
  );
  const gatewayState = await prepareRoleState(baseDir, "gateway", token, "gateway", {
    liveModel: live ? liveModel : undefined,
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
            liveModel,
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
  const defaultLiveModel =
    args["hot-plug"] === true ? DEFAULT_HOT_PLUG_LIVE_MODEL : DEFAULT_LIVE_MODEL;
  const liveModel = String(args.model || process.env.OPENCLAW_POND_LIVE_MODEL || defaultLiveModel);
  const liveProvider = liveModel.split("/", 1)[0];
  const liveKeyPresent =
    liveProvider === "openai"
      ? Boolean(process.env.OPENAI_API_KEY?.trim() || process.env.OPENCLAW_LIVE_OPENAI_KEY?.trim())
      : liveProvider === "anthropic"
        ? Boolean(process.env.ANTHROPIC_API_KEY?.trim())
        : true;
  if (args.live === true && !liveKeyPresent) {
    console.error(`--live with ${liveModel} requires the matching provider API key`);
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
    if (args["hot-plug"] === true) {
      await runHotPlugLocal(args);
    } else {
      await runLocal(args);
    }
    return;
  }
  throw new Error(
    "usage: node scripts/e2e/node-plugin-tools-pond.mjs [local|gateway|node|verify] [--build] [--live] [--hot-plug] [--model provider/model]",
  );
}

main().catch(
  /** @param {unknown} err */ (err) => {
    console.error(err instanceof Error ? err.stack || err.message : String(err));
    process.exitCode = 1;
  },
);
