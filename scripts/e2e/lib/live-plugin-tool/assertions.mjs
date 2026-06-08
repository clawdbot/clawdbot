// Assertions for live plugin tool E2E scenarios.
import fs from "node:fs";
import path from "node:path";
import { extractAgentReplyTexts } from "../agent-turn-output.mjs";
import { readPluginInstallRecords } from "../plugin-index-sqlite.mjs";
import { readTextFileTail, tailText } from "../text-file-utils.mjs";

const command = process.argv[2];
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

function readPositiveIntEnv(name, fallback) {
  const text = String(process.env[name] ?? fallback).trim();
  if (!/^\d+$/u.test(text)) {
    throw new Error(`invalid ${name}: ${text}`);
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`invalid ${name}: ${text}`);
  }
  return value;
}

const agentTurnTimeoutSeconds = readPositiveIntEnv(
  "OPENCLAW_LIVE_PLUGIN_TOOL_TIMEOUT_SECONDS",
  300,
);
const SCAN_CHUNK_BYTES = 64 * 1024;
const SCAN_CARRY_CHARS = 256;
const SESSION_JSONL_LINE_MAX_BYTES = 1024 * 1024;
const ERROR_DETAIL_TAIL_BYTES = 16 * 1024;
const AGENT_OUTPUT_MAX_BYTES = readPositiveIntEnv(
  "OPENCLAW_LIVE_PLUGIN_TOOL_AGENT_OUTPUT_MAX_BYTES",
  1024 * 1024,
);
const SESSION_FILE_LIST_LIMIT = 20;
const SESSION_SCAN_MAX_ENTRIES = readPositiveIntEnv(
  "OPENCLAW_LIVE_PLUGIN_TOOL_SESSION_SCAN_MAX_ENTRIES",
  50_000,
);

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing ${name}`);
  }
  return value;
}

function stateDir() {
  return process.env.OPENCLAW_STATE_DIR || path.join(process.env.HOME, ".openclaw");
}

function configPath() {
  return process.env.OPENCLAW_CONFIG_PATH || path.join(stateDir(), "openclaw.json");
}

function agentOutputPath() {
  return process.env.OPENCLAW_LIVE_PLUGIN_TOOL_AGENT_OUTPUT_PATH || "/tmp/openclaw-agent.json";
}

function agentErrorPath() {
  return process.env.OPENCLAW_LIVE_PLUGIN_TOOL_AGENT_ERROR_PATH || "/tmp/openclaw-agent.err";
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readNonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeToolCallId(value) {
  const id = readNonEmptyString(value);
  return id || undefined;
}

function stringifyToolResult(value) {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((entry) => stringifyToolResult(entry))
      .filter(Boolean)
      .join("\n");
  }
  if (!isRecord(value)) {
    return value == null ? "" : String(value);
  }
  const nested = value.text ?? value.content ?? value.result ?? value.output;
  return nested === undefined ? JSON.stringify(value) : stringifyToolResult(nested);
}

function extractTranscriptText(value) {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((entry) => extractTranscriptText(entry))
      .filter(Boolean)
      .join("\n");
  }
  if (!isRecord(value)) {
    return value == null ? "" : String(value);
  }
  return extractTranscriptText(value.text ?? value.content ?? value.result ?? value.output ?? "");
}

function extractTranscriptToolCalls(message) {
  const calls = [];
  const content = message.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!isRecord(block)) {
        continue;
      }
      const type = readNonEmptyString(block.type)?.toLowerCase();
      if (type !== "tool_use" && type !== "toolcall" && type !== "tool_call") {
        continue;
      }
      const tool = readNonEmptyString(block.name);
      if (!tool) {
        continue;
      }
      calls.push({
        id:
          normalizeToolCallId(block.id) ??
          normalizeToolCallId(block.toolCallId) ??
          normalizeToolCallId(block.toolUseId),
        tool,
      });
    }
  }

  const rawToolCalls =
    message.tool_calls ?? message.toolCalls ?? message.function_call ?? message.functionCall;
  const toolCalls = Array.isArray(rawToolCalls) ? rawToolCalls : rawToolCalls ? [rawToolCalls] : [];
  for (const call of toolCalls) {
    if (!isRecord(call)) {
      continue;
    }
    const functionRecord = isRecord(call.function) ? call.function : undefined;
    const tool = readNonEmptyString(call.name) ?? readNonEmptyString(functionRecord?.name);
    if (!tool) {
      continue;
    }
    calls.push({
      id:
        normalizeToolCallId(call.id) ??
        normalizeToolCallId(call.toolCallId) ??
        normalizeToolCallId(call.toolUseId),
      tool,
    });
  }
  return calls;
}

function isFailureLikeToolResult(params) {
  return (
    params.type === "tool_result_error" ||
    params.isError === true ||
    params.is_error === true ||
    /\b(?:denied|enoent|error|exception|fail(?:ed|ure)?|forbidden|invalid|missing|not found|permission)\b/iu.test(
      params.text,
    )
  );
}

function extractTranscriptToolResults(message) {
  const results = [];
  const tool =
    readNonEmptyString(message.toolName) ??
    readNonEmptyString(message.tool_name) ??
    readNonEmptyString(message.name) ??
    readNonEmptyString(message.tool);
  if ((message.role === "tool" || message.role === "toolResult") && message.content !== undefined) {
    const text = extractTranscriptText(message.content);
    results.push({
      id:
        normalizeToolCallId(message.tool_call_id) ??
        normalizeToolCallId(message.toolCallId) ??
        normalizeToolCallId(message.toolUseId) ??
        normalizeToolCallId(message.id),
      ...(tool ? { tool } : {}),
      text,
      failure: isFailureLikeToolResult({
        text,
        isError: message.isError,
        is_error: message.is_error,
      }),
    });
  }

  const content = message.content;
  if (!Array.isArray(content)) {
    return results;
  }
  for (const block of content) {
    if (!isRecord(block)) {
      continue;
    }
    const type = readNonEmptyString(block.type)?.toLowerCase();
    if (type !== "tool_result" && type !== "toolresult" && type !== "tool_result_error") {
      continue;
    }
    const text = stringifyToolResult(
      block.content ?? block.text ?? block.result ?? block.output ?? block.error ?? block.message,
    );
    const blockTool =
      readNonEmptyString(block.toolName) ??
      readNonEmptyString(block.tool_name) ??
      readNonEmptyString(block.name) ??
      readNonEmptyString(block.tool);
    results.push({
      id:
        normalizeToolCallId(block.tool_use_id) ??
        normalizeToolCallId(block.toolUseId) ??
        normalizeToolCallId(block.tool_call_id) ??
        normalizeToolCallId(block.toolCallId) ??
        normalizeToolCallId(block.id),
      ...(blockTool ? { tool: blockTool } : {}),
      text,
      failure: isFailureLikeToolResult({
        type,
        text,
        isError: block.isError,
        is_error: block.is_error,
      }),
    });
  }
  return results;
}

function resultLinksToolCall(call, result, targetCallCount) {
  if (call.id || result.id) {
    return Boolean(call.id && result.id && call.id === result.id);
  }
  if (result.tool) {
    return result.tool === call.tool;
  }
  return targetCallCount === 1;
}

function createToolEvidenceTracker(toolName, expected) {
  const calls = [];
  return {
    recordMessage(message) {
      for (const call of extractTranscriptToolCalls(message)) {
        if (call.tool === toolName) {
          calls.push(call);
        }
      }
      for (const result of extractTranscriptToolResults(message)) {
        if (result.failure || !result.text.includes(expected)) {
          continue;
        }
        if (calls.some((call) => resultLinksToolCall(call, result, calls.length))) {
          return true;
        }
      }
      return false;
    },
  };
}

function transcriptMessageFromLine(line) {
  try {
    const parsed = JSON.parse(line);
    if (!isRecord(parsed)) {
      return undefined;
    }
    return isRecord(parsed.message) ? parsed.message : parsed;
  } catch {
    return undefined;
  }
}

function scanFileForToolEvidence(file, toolName, expected) {
  const tracker = createToolEvidenceTracker(toolName, expected);
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return false;
  }
  if (!stat.isFile() || stat.size <= 0) {
    return false;
  }

  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(Math.min(SCAN_CHUNK_BYTES, stat.size));
    let pendingLine = "";
    let offset = 0;
    while (offset < stat.size) {
      const bytesToRead = Math.min(buffer.length, stat.size - offset);
      const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, offset);
      if (bytesRead <= 0) {
        break;
      }
      offset += bytesRead;
      const lines = (pendingLine + buffer.subarray(0, bytesRead).toString("utf8")).split(/\r?\n/u);
      pendingLine = lines.pop() ?? "";
      if (Buffer.byteLength(pendingLine) > SESSION_JSONL_LINE_MAX_BYTES) {
        pendingLine = pendingLine.slice(-SCAN_CARRY_CHARS);
      }
      for (const line of lines) {
        const message = transcriptMessageFromLine(line.trim());
        if (message && tracker.recordMessage(message)) {
          return true;
        }
      }
    }
    const message = transcriptMessageFromLine(pendingLine.trim());
    if (message && tracker.recordMessage(message)) {
      return true;
    }
  } finally {
    fs.closeSync(fd);
  }
  return false;
}

function scanSessionTranscripts(sessionsDir, toolName, expected) {
  const checkedFiles = [];
  let filesChecked = 0;
  let stat;
  try {
    stat = fs.statSync(sessionsDir);
  } catch {
    return { checkedFiles, filesChecked, found: false, missingDir: true };
  }
  if (!stat.isDirectory()) {
    return { checkedFiles, filesChecked, found: false, missingDir: true };
  }

  const pendingDirs = [sessionsDir];
  let scannedEntries = 0;
  while (pendingDirs.length > 0) {
    const dir = pendingDirs.pop();
    const handle = fs.opendirSync(dir);
    try {
      let entry;
      while ((entry = handle.readSync()) !== null) {
        scannedEntries += 1;
        if (scannedEntries > SESSION_SCAN_MAX_ENTRIES) {
          throw new Error(
            `session transcript scan exceeded ${SESSION_SCAN_MAX_ENTRIES} filesystem entries`,
          );
        }
        const entryPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          pendingDirs.push(entryPath);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
          continue;
        }
        filesChecked += 1;
        if (checkedFiles.length < SESSION_FILE_LIST_LIMIT) {
          checkedFiles.push(path.relative(sessionsDir, entryPath));
        }
        if (scanFileForToolEvidence(entryPath, toolName, expected)) {
          return { checkedFiles, filesChecked, found: true, missingDir: false };
        }
      }
    } finally {
      handle.closeSync();
    }
  }
  return { checkedFiles, filesChecked, found: false, missingDir: false };
}

function realPathMaybe(filePath) {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function assertPathInside(parentPath, childPath, label) {
  const parent = realPathMaybe(parentPath);
  const child = realPathMaybe(childPath);
  const relative = path.relative(parent, child);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} resolved outside ${parentPath}: ${child}`);
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function installRecords() {
  const cfg = fs.existsSync(configPath()) ? readJson(configPath()) : {};
  return readPluginInstallRecords({
    stateDir: stateDir(),
    configPath: configPath(),
    fallbackRecords: cfg.plugins?.installs ?? {},
  });
}

function pluginInstallPath() {
  const pluginId = requireEnv("PLUGIN_ID");
  const inspect = fs.existsSync("/tmp/openclaw-plugin-inspect.json")
    ? readJson("/tmp/openclaw-plugin-inspect.json")
    : {};
  const record = installRecords()[pluginId] || inspect.install;
  if (!record) {
    throw new Error(`missing ${pluginId} install record`);
  }
  if (record.source !== "npm" || record.artifactKind !== "npm-pack") {
    throw new Error(`expected npm-pack install record: ${JSON.stringify(record)}`);
  }
  return String(record.installPath || "").replace(/^~(?=$|\/)/u, process.env.HOME);
}

function writeFixture() {
  const dir = process.argv[3];
  if (!dir) {
    throw new Error("write-fixture requires output dir");
  }
  const pluginId = requireEnv("PLUGIN_ID");
  const pluginName = requireEnv("PLUGIN_NAME");
  const version = requireEnv("PLUGIN_VERSION");
  const toolName = requireEnv("TOOL_NAME");
  const seed = requireEnv("SEED");
  writeJson(path.join(dir, "package.json"), {
    name: pluginName,
    version,
    dependencies: { slugify: "^1.6.6" },
    openclaw: { extensions: ["./index.js"] },
  });
  writeJson(path.join(dir, "openclaw.plugin.json"), {
    id: pluginId,
    name: "E2E Slug Tool",
    description: "Docker E2E plugin tool fixture",
    activation: { onStartup: true },
    contracts: { tools: [toolName] },
    configSchema: { type: "object", additionalProperties: false },
  });
  fs.writeFileSync(
    path.join(dir, "index.js"),
    `const slugify = require("slugify");\n` +
      `const value = slugify(${JSON.stringify(seed)}, { lower: true, strict: true });\n` +
      `module.exports = {\n` +
      `  id: ${JSON.stringify(pluginId)},\n` +
      `  name: "E2E Slug Tool",\n` +
      `  register(api) {\n` +
      `    api.registerTool({\n` +
      `      name: ${JSON.stringify(toolName)},\n` +
      `      description: "Return the hidden Docker E2E slug generated by the plugin dependency.",\n` +
      `      parameters: { type: "object", properties: {}, additionalProperties: false },\n` +
      `      async execute() {\n` +
      `        return { content: [{ type: "text", text: value }] };\n` +
      `      },\n` +
      `    });\n` +
      `  },\n` +
      `};\n`,
  );
}

function configure() {
  const modelRef = requireEnv("MODEL_REF");
  const pluginId = requireEnv("PLUGIN_ID");
  const toolName = requireEnv("TOOL_NAME");
  const cfgPath = configPath();
  const cfg = fs.existsSync(cfgPath) ? readJson(cfgPath) : {};
  const [providerId, modelId] = modelRef.split("/");
  if (providerId !== "openai" || !modelId) {
    throw new Error(`live plugin tool E2E expects an openai/* model, got ${modelRef}`);
  }
  cfg.plugins = {
    ...cfg.plugins,
    enabled: true,
    allow: Array.from(new Set([...(cfg.plugins?.allow || []), "openai", pluginId])).toSorted(
      (left, right) => left.localeCompare(right),
    ),
    entries: {
      ...cfg.plugins?.entries,
      openai: { ...cfg.plugins?.entries?.openai, enabled: true },
      [pluginId]: { ...cfg.plugins?.entries?.[pluginId], enabled: true },
    },
  };
  cfg.tools = {
    ...cfg.tools,
    allow: [toolName],
  };
  cfg.models = {
    ...cfg.models,
    mode: "merge",
    providers: {
      ...cfg.models?.providers,
      openai: {
        ...cfg.models?.providers?.openai,
        api: "openai-responses",
        baseUrl: (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").trim(),
        apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
        agentRuntime: { id: "openclaw" },
        timeoutSeconds: agentTurnTimeoutSeconds,
        models: [
          {
            id: modelId,
            name: modelId,
            api: "openai-responses",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            contextTokens: 96000,
            maxTokens: 512,
          },
        ],
      },
    },
  };
  cfg.agents = {
    ...cfg.agents,
    defaults: {
      ...cfg.agents?.defaults,
      model: { primary: modelRef, fallbacks: [] },
      models: {
        ...cfg.agents?.defaults?.models,
        [modelRef]: {
          ...cfg.agents?.defaults?.models?.[modelRef],
          agentRuntime: { id: "openclaw" },
          params: { transport: "sse", openaiWsWarmup: false },
        },
      },
      workspace: path.join(stateDir(), "workspace"),
      skipBootstrap: true,
      timeoutSeconds: agentTurnTimeoutSeconds,
    },
  };
  writeJson(cfgPath, cfg);
}

function findDependencyPackageJson(packageName) {
  const installPath = pluginInstallPath();
  const npmRoot = path.join(stateDir(), "npm");
  const pluginName = requireEnv("PLUGIN_NAME");
  const packageRoot = pluginName.split("/").reduce((current) => path.dirname(current), installPath);
  const projectRoot =
    path.basename(packageRoot) === "node_modules" ? path.dirname(packageRoot) : npmRoot;
  return [
    path.join(projectRoot, "node_modules", packageName, "package.json"),
    path.join(installPath, "node_modules", packageName, "package.json"),
    path.join(npmRoot, "node_modules", packageName, "package.json"),
  ].find((candidate) => fs.existsSync(candidate));
}

function assertInstalled() {
  const pluginId = requireEnv("PLUGIN_ID");
  const pluginName = requireEnv("PLUGIN_NAME");
  const toolName = requireEnv("TOOL_NAME");
  const npmRoot = path.join(stateDir(), "npm");
  const installPath = pluginInstallPath();
  assertPathInside(npmRoot, installPath, "fixture plugin install path");
  const packageJson = path.join(installPath, "package.json");
  if (!fs.existsSync(packageJson)) {
    throw new Error(`missing fixture plugin package.json: ${packageJson}`);
  }
  const pkg = readJson(packageJson);
  if (pkg.name !== pluginName) {
    throw new Error(`unexpected fixture package name: ${pkg.name}`);
  }
  const slugifyPackageJson = findDependencyPackageJson("slugify");
  if (!slugifyPackageJson) {
    throw new Error("missing slugify dependency installed by npm-pack plugin install");
  }
  assertPathInside(npmRoot, slugifyPackageJson, "slugify dependency");

  const list = readJson("/tmp/openclaw-plugins-list.json");
  const plugin = (list.plugins || []).find((entry) => entry.id === pluginId);
  if (!plugin || plugin.enabled !== true || plugin.status !== "loaded") {
    throw new Error(`fixture plugin was not enabled+loaded: ${JSON.stringify(plugin)}`);
  }
  const inspect = readJson("/tmp/openclaw-plugin-inspect.json");
  const toolNames = Array.isArray(inspect.tools)
    ? inspect.tools.flatMap((entry) => (Array.isArray(entry?.names) ? entry.names : []))
    : [];
  if (!toolNames.includes(toolName)) {
    throw new Error(`fixture tool was not registered: ${JSON.stringify(inspect.tools)}`);
  }
}

function assertAgentTurn() {
  const expected = requireEnv("EXPECTED_SLUG");
  const toolName = requireEnv("TOOL_NAME");
  const outputPath = agentOutputPath();
  const errorPath = agentErrorPath();
  const outputStat = fs.statSync(outputPath);
  if (outputStat.isFile() && outputStat.size > AGENT_OUTPUT_MAX_BYTES) {
    const stdoutTail = readTextFileTail(outputPath, ERROR_DETAIL_TAIL_BYTES);
    const stderrTail = readTextFileTail(errorPath, ERROR_DETAIL_TAIL_BYTES);
    throw new Error(
      `live agent output exceeded ${AGENT_OUTPUT_MAX_BYTES} bytes:\nstdout tail=${stdoutTail}\nstderr tail=${stderrTail}`,
    );
  }
  const stdout = fs.readFileSync(outputPath, "utf8");
  const response = JSON.parse(stdout);
  const text = extractAgentReplyTexts(JSON.stringify(response)).join("\n");
  if (!text.includes(expected)) {
    const stderrTail = readTextFileTail(errorPath, ERROR_DETAIL_TAIL_BYTES);
    throw new Error(
      `live agent reply did not contain tool slug ${expected}:\nstdout tail=${tailText(stdout, ERROR_DETAIL_TAIL_BYTES)}\nstderr tail=${stderrTail}`,
    );
  }
  const sessionsDir = path.join(stateDir(), "agents", "main", "sessions");
  const scan = scanSessionTranscripts(sessionsDir, toolName, expected);
  if (!scan.found) {
    const checkedFiles = scan.checkedFiles.length > 0 ? scan.checkedFiles.join(", ") : "<none>";
    const missingDir = scan.missingDir ? " sessions directory was missing." : "";
    throw new Error(
      `session transcript did not show ${toolName} returning ${expected}; missing causal tool-result evidence after checking ${scan.filesChecked} jsonl file(s): ${checkedFiles}.${missingDir}`,
    );
  }
}

const commands = {
  "write-fixture": writeFixture,
  configure,
  "assert-installed": assertInstalled,
  "assert-agent-turn": assertAgentTurn,
};

const fn = commands[command];
if (!fn) {
  throw new Error(`unknown live plugin tool assertion command: ${command}`);
}
fn();
