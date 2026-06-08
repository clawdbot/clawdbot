// Assertions for Codex npm plugin live E2E scenarios.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { extractAgentReplyTexts } from "../agent-turn-output.mjs";
import {
  assertPathInside,
  configPath,
  findPackageJson,
  managedNpmRoot,
  npmProjectRootForInstalledPackage,
  readInstallRecords,
  readJson,
  realPathMaybe,
  stateDir,
} from "../codex-install-utils.mjs";

const command = process.argv[2];
const allowBetaCompatDiagnostics =
  process.env.OPENCLAW_CODEX_NPM_PLUGIN_ALLOW_BETA_COMPAT_DIAGNOSTICS === "1";
const MAX_TEXT_FILE_BYTES = readPositiveIntEnv(
  "OPENCLAW_CODEX_NPM_PLUGIN_ASSERT_MAX_TEXT_FILE_BYTES",
  1024 * 1024,
);
const MAX_ERROR_TAIL_BYTES = readPositiveIntEnv(
  "OPENCLAW_CODEX_NPM_PLUGIN_ASSERT_MAX_ERROR_TAIL_BYTES",
  64 * 1024,
);
const MAX_TRANSCRIPT_FILES = readPositiveIntEnv(
  "OPENCLAW_CODEX_NPM_PLUGIN_ASSERT_MAX_TRANSCRIPT_FILES",
  64,
);
const MAX_TRANSCRIPT_WALK_ENTRIES = readPositiveIntEnv(
  "OPENCLAW_CODEX_NPM_PLUGIN_ASSERT_MAX_TRANSCRIPT_WALK_ENTRIES",
  4096,
);
const MAX_TRANSCRIPT_SCAN_BYTES = readPositiveIntEnv(
  "OPENCLAW_CODEX_NPM_PLUGIN_ASSERT_MAX_TRANSCRIPT_SCAN_BYTES",
  2 * 1024 * 1024,
);
const SESSION_STORE_SCOPE = "session_entries";

function readPositiveIntEnv(name, fallback) {
  const text = String(process.env[name] ?? fallback).trim();
  if (!/^\d+$/u.test(text)) {
    throw new Error(`${name} must be a positive integer; got: ${text}`);
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer; got: ${text}`);
  }
  return value;
}

function readTextFileBounded(filePath, label, maxBytes = MAX_TEXT_FILE_BYTES) {
  const stat = fs.statSync(filePath);
  if (stat.size > maxBytes) {
    throw new Error(`${label} exceeded ${maxBytes} bytes: ${filePath}`);
  }
  return fs.readFileSync(filePath, "utf8");
}

function readTextFileTail(filePath, label, maxBytes = MAX_ERROR_TAIL_BYTES) {
  if (!fs.existsSync(filePath)) {
    return "";
  }
  const stat = fs.statSync(filePath);
  if (stat.size <= maxBytes) {
    return fs.readFileSync(filePath, "utf8");
  }
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    fs.readSync(fd, buffer, 0, maxBytes, stat.size - maxBytes);
    return `[${label} truncated to last ${maxBytes} bytes]\n${buffer.toString("utf8")}`;
  } finally {
    fs.closeSync(fd);
  }
}

function readSqliteSessionStore(agentId = "main") {
  const dbPath = path.join(stateDir(), "agents", agentId, "agent", "openclaw-agent.sqlite");
  if (!fs.existsSync(dbPath)) {
    throw new Error(`session SQLite store was not persisted: ${dbPath}`);
  }
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db
      .prepare("SELECT key, value_json FROM cache_entries WHERE scope = ? ORDER BY key ASC")
      .all(SESSION_STORE_SCOPE);
    const store = {};
    for (const row of rows) {
      if (typeof row?.key !== "string" || typeof row?.value_json !== "string") {
        continue;
      }
      store[row.key] = JSON.parse(row.value_json);
    }
    return store;
  } finally {
    db?.close();
  }
}

function configure() {
  const modelRef = process.argv[3] || "codex/gpt-5.4";
  const state = stateDir();
  const cfgPath = configPath();
  const cfg = fs.existsSync(cfgPath) ? readJson(cfgPath) : {};
  cfg.plugins = {
    ...cfg.plugins,
    enabled: true,
    allow: Array.from(new Set([...(cfg.plugins?.allow || []), "codex"])).toSorted((left, right) =>
      left.localeCompare(right),
    ),
    entries: {
      ...cfg.plugins?.entries,
      codex: {
        ...cfg.plugins?.entries?.codex,
        enabled: true,
        config: {
          ...cfg.plugins?.entries?.codex?.config,
          discovery: { enabled: false },
          appServer: {
            ...cfg.plugins?.entries?.codex?.config?.appServer,
            mode: "yolo",
            approvalPolicy: "never",
            sandbox: "danger-full-access",
            requestTimeoutMs: 420_000,
          },
        },
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
        [modelRef]: { agentRuntime: { id: "codex" } },
      },
      workspace: path.join(state, "workspace"),
      skipBootstrap: true,
      timeoutSeconds: 420,
    },
  };
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);
}

function readInstallRecord() {
  const record = readInstallRecords().codex;
  if (!record) {
    throw new Error("missing codex install record");
  }
  return record;
}

function normalizePluginSpec(spec) {
  if (spec.startsWith("npm:")) {
    return {
      expectedSpec: spec.slice("npm:".length),
      source: "npm",
    };
  }
  if (spec.startsWith("npm-pack:")) {
    return {
      artifactKind: "npm-pack",
      source: "npm",
      sourcePath: spec.slice("npm-pack:".length),
    };
  }
  if (spec.startsWith("git:")) {
    return {
      expectedSpec: spec,
      source: "git",
    };
  }
  return {
    expectedSpec: spec,
    source: "npm",
  };
}

function assertPlugin() {
  const spec = process.argv[3] || "npm:@openclaw/codex";
  const list = readJson("/tmp/openclaw-codex-plugins-list.json");
  const inspect = readJson("/tmp/openclaw-codex-plugin-inspect.json");
  const plugin = (list.plugins || []).find((entry) => entry.id === "codex");
  if (!plugin) {
    throw new Error("codex plugin not found in plugins list --json output");
  }
  if (plugin.status !== "loaded" || plugin.enabled !== true) {
    throw new Error(
      `expected codex to be enabled+loaded, got enabled=${plugin.enabled} status=${plugin.status}`,
    );
  }
  if (inspect.plugin?.id !== "codex" || inspect.plugin?.status !== "loaded") {
    throw new Error(`unexpected inspect plugin state: ${JSON.stringify(inspect.plugin)}`);
  }
  if (
    !Array.isArray(inspect.plugin?.providerIds) ||
    !inspect.plugin.providerIds.includes("codex")
  ) {
    throw new Error(`codex provider was not registered: ${JSON.stringify(inspect.plugin)}`);
  }
  const hasCodexHarness =
    (Array.isArray(inspect.plugin?.agentHarnessIds) &&
      inspect.plugin.agentHarnessIds.includes("codex")) ||
    (Array.isArray(inspect.capabilities) &&
      inspect.capabilities.some(
        (entry) => entry?.kind === "agent-harness" && entry.ids?.includes("codex"),
      ));
  if (!hasCodexHarness) {
    throw new Error(`codex harness was not registered: ${JSON.stringify(inspect.plugin)}`);
  }
  const diagnostics = [...(list.diagnostics || []), ...(inspect.diagnostics || [])];
  const errors = diagnostics
    .filter((diag) => diag?.level === "error")
    .map((diag) => String(diag.message || ""));
  const unexpectedErrors = allowBetaCompatDiagnostics
    ? errors.filter(
        (message) => message !== "only bundled plugins can claim reserved command ownership: codex",
      )
    : errors;
  if (unexpectedErrors.length > 0) {
    throw new Error(`unexpected plugin diagnostics errors: ${unexpectedErrors.join("; ")}`);
  }

  const record = readInstallRecord();
  const expected = normalizePluginSpec(spec);
  if (record.source !== expected.source) {
    throw new Error(
      `expected codex ${expected.source} install record, got source=${record.source}`,
    );
  }
  if (expected.expectedSpec && record.spec !== expected.expectedSpec) {
    throw new Error(`expected codex install spec ${expected.expectedSpec}, got ${record.spec}`);
  }
  if (expected.artifactKind && record.artifactKind !== expected.artifactKind) {
    throw new Error(
      `expected codex artifact kind ${expected.artifactKind}, got ${record.artifactKind}`,
    );
  }
  if (
    expected.sourcePath &&
    realPathMaybe(record.sourcePath || "") !== realPathMaybe(expected.sourcePath)
  ) {
    throw new Error(`expected codex source path ${expected.sourcePath}, got ${record.sourcePath}`);
  }
  if (record.source === "npm" && (!record.resolvedVersion || !record.resolvedSpec)) {
    throw new Error(`missing codex npm resolution metadata: ${JSON.stringify(record)}`);
  }
  if (record.source === "git" && !record.gitCommit) {
    throw new Error(`missing codex git resolution metadata: ${JSON.stringify(record)}`);
  }
}

function codexInstallPath() {
  const record = readInstallRecord();
  if (typeof record.installPath !== "string" || record.installPath.length === 0) {
    throw new Error(`missing codex installPath: ${JSON.stringify(record)}`);
  }
  return record.installPath.replace(/^~(?=$|\/)/u, process.env.HOME);
}

function codexNpmProjectRoot() {
  return npmProjectRootForInstalledPackage(codexInstallPath(), "@openclaw/codex");
}

function findCodexPackageJson(packageName) {
  const projectRoot = codexNpmProjectRoot();
  return findPackageJson(packageName, [projectRoot, codexInstallPath(), managedNpmRoot()]);
}

function assertNpmDeps() {
  const npmRoot = managedNpmRoot();
  const installPath = codexInstallPath();
  const pluginPackageJson = path.join(installPath, "package.json");
  if (!fs.existsSync(pluginPackageJson)) {
    throw new Error(`missing npm-installed @openclaw/codex package.json: ${pluginPackageJson}`);
  }
  assertPathInside(npmRoot, installPath, "codex plugin install path");
  assertPathInside(npmRoot, pluginPackageJson, "codex plugin package");

  const pluginPackage = readJson(pluginPackageJson);
  if (pluginPackage.name !== "@openclaw/codex") {
    throw new Error(`unexpected codex package name: ${pluginPackage.name}`);
  }

  const openAiCodexPackageJson = findCodexPackageJson("@openai/codex");
  if (!openAiCodexPackageJson) {
    throw new Error("missing @openai/codex dependency under .openclaw/npm");
  }
  assertPathInside(npmRoot, openAiCodexPackageJson, "@openai/codex dependency");

  const bin = resolveCodexBin();
  if (!fs.existsSync(bin)) {
    throw new Error(`missing managed Codex binary: ${bin}`);
  }
  assertPathInside(npmRoot, bin, "managed Codex binary");
}

function resolveCodexBin() {
  const commandName = process.platform === "win32" ? "codex.cmd" : "codex";
  const candidates = [
    path.join(codexNpmProjectRoot(), "node_modules", ".bin", commandName),
    path.join(codexInstallPath(), "node_modules", ".bin", commandName),
    path.join(managedNpmRoot(), "node_modules", ".bin", commandName),
  ];
  const candidate = candidates.find((entry) => fs.existsSync(entry));
  if (candidate) {
    return candidate;
  }
  const packageJson = findCodexPackageJson("@openai/codex");
  if (!packageJson) {
    throw new Error("cannot resolve Codex binary without @openai/codex package");
  }
  const packageRoot = path.dirname(packageJson);
  const pkg = readJson(packageJson);
  const binPath =
    typeof pkg.bin === "string"
      ? pkg.bin
      : pkg.bin && typeof pkg.bin.codex === "string"
        ? pkg.bin.codex
        : undefined;
  if (!binPath) {
    throw new Error(`@openai/codex package has no codex bin: ${packageJson}`);
  }
  return path.resolve(packageRoot, binPath);
}

function printCodexBin() {
  assertNpmDeps();
  process.stdout.write(`${resolveCodexBin()}\n`);
}

function assertPreflight() {
  const marker = process.argv[3];
  const output = readTextFileBounded("/tmp/openclaw-codex-preflight.log", "Codex preflight log");
  if (!output.includes(marker)) {
    throw new Error(`Codex CLI preflight did not contain ${marker}:\n${output}`);
  }
}

function listFilesRecursive(root) {
  if (!fs.existsSync(root)) {
    return [];
  }
  const files = [];
  const stack = [root];
  let visited = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      visited += 1;
      if (visited > MAX_TRANSCRIPT_WALK_ENTRIES) {
        throw new Error(
          `native Codex session transcript walk exceeded ${MAX_TRANSCRIPT_WALK_ENTRIES} entries under ${root}`,
        );
      }
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

function assertNativeCodexSessionEvidence(params) {
  const roots = params.roots.filter((root) => fs.existsSync(root));
  const files = roots
    .flatMap((root) => listFilesRecursive(root).filter((filePath) => filePath.endsWith(".jsonl")))
    .map((filePath) => ({ filePath, stat: fs.statSync(filePath) }))
    .toSorted((left, right) => right.stat.mtimeMs - left.stat.mtimeMs)
    .slice(0, MAX_TRANSCRIPT_FILES);
  if (files.length === 0) {
    throw new Error(
      `missing native Codex session transcript files; checked ${params.roots.join(", ")}`,
    );
  }
  let scannedBytes = 0;
  const matchingFile = files.find(({ filePath, stat }) => {
    const readableBytes = Math.min(stat.size, MAX_TEXT_FILE_BYTES);
    if (scannedBytes + readableBytes > MAX_TRANSCRIPT_SCAN_BYTES) {
      return false;
    }
    scannedBytes += readableBytes;
    const content = readTextFileTail(filePath, "native Codex session transcript", readableBytes);
    return content.includes(params.marker) || content.includes(params.threadId);
  })?.filePath;
  if (!matchingFile) {
    throw new Error(
      `native Codex session transcripts did not contain ${params.marker} or ${params.threadId}; scanned ${scannedBytes} bytes across ${files.length} newest files: ${files.map((entry) => entry.filePath).join(", ")}`,
    );
  }
  assertPathInside(params.codexHome, matchingFile, "native Codex session transcript");
}

function assertAgentTurn() {
  const marker = process.argv[3];
  const sessionId = process.argv[4];
  const modelRef = process.argv[5];
  const stdout = readTextFileBounded("/tmp/openclaw-codex-agent.json", "OpenClaw agent JSON");
  const stderr = readTextFileTail("/tmp/openclaw-codex-agent.err", "OpenClaw agent stderr");
  const response = JSON.parse(stdout);
  const text = extractAgentReplyTexts(JSON.stringify(response)).join("\n");
  if (!text.includes(marker)) {
    throw new Error(
      `OpenClaw agent reply did not contain ${marker}:\nstdout=${stdout}\nstderr=${stderr}`,
    );
  }
  const expectedProvider = modelRef.split("/")[0] || "codex";
  const executionTrace = response.meta?.executionTrace;
  if (!executionTrace || executionTrace.winnerProvider !== expectedProvider) {
    throw new Error(
      `expected Codex plugin model provider ${expectedProvider} to win the agent turn, got ${JSON.stringify(executionTrace)}`,
    );
  }

  const store = readSqliteSessionStore("main");
  const entry = Object.values(store).find((candidate) => candidate?.sessionId === sessionId);
  if (!entry) {
    throw new Error(`missing session store entry for ${sessionId}: ${JSON.stringify(store)}`);
  }
  if (entry.agentHarnessId !== "codex") {
    throw new Error(`expected codex harness in session entry, got ${entry.agentHarnessId}`);
  }
  if (entry.modelOverride && entry.modelOverride !== modelRef) {
    throw new Error(`unexpected session model override: ${entry.modelOverride}`);
  }
  if (typeof entry.sessionFile !== "string" || !fs.existsSync(entry.sessionFile)) {
    throw new Error(`missing OpenClaw session file: ${entry.sessionFile}`);
  }

  const bindingPath = `${entry.sessionFile}.codex-app-server.json`;
  const binding = readJson(bindingPath);
  if (binding.schemaVersion !== 1 || typeof binding.threadId !== "string") {
    throw new Error(`invalid Codex app-server binding: ${JSON.stringify(binding)}`);
  }
  if (binding.model !== modelRef.split("/").slice(1).join("/")) {
    throw new Error(`unexpected Codex binding model: ${binding.model}`);
  }
  if (binding.modelProvider && !["codex", "openai"].includes(binding.modelProvider)) {
    throw new Error(`unexpected Codex binding provider: ${binding.modelProvider}`);
  }

  const agentDir = path.join(stateDir(), "agents", "main");
  const codexHomes = [
    path.join(agentDir, "codex-home"),
    path.join(agentDir, "agent", "codex-home"),
    path.join(path.dirname(agentDir), "codex-home"),
  ].filter((entryValue, index, entries) => entries.indexOf(entryValue) === index);
  const codexHome = codexHomes.find((entryLocal) => fs.existsSync(entryLocal));
  if (!codexHome) {
    throw new Error(`missing isolated Codex home; checked ${codexHomes.join(", ")}`);
  }
  const codexSessionRoot = path.join(codexHome, "sessions");
  const nativeSessionRoot = path.join(codexHome, "home", ".codex", "sessions");
  assertNativeCodexSessionEvidence({
    codexHome,
    marker,
    roots: [codexSessionRoot, nativeSessionRoot],
    threadId: binding.threadId,
  });
}

function assertUninstalled() {
  const records = readInstallRecords();
  if (records.codex) {
    throw new Error(
      `codex install record still exists after uninstall: ${JSON.stringify(records.codex)}`,
    );
  }
  const list = readJson("/tmp/openclaw-codex-plugins-list-after-uninstall.json");
  const plugin = (list.plugins || []).find((entry) => entry.id === "codex");
  if (plugin?.status === "loaded" || plugin?.enabled === true) {
    throw new Error(`codex plugin still loaded/enabled after uninstall: ${JSON.stringify(plugin)}`);
  }
  const diagnostics = list.diagnostics || [];
  const errors = diagnostics
    .filter((diag) => diag?.level === "error")
    .map((diag) => String(diag.message || ""));
  if (errors.length > 0) {
    throw new Error(`unexpected plugin diagnostics errors after uninstall: ${errors.join("; ")}`);
  }
}

function assertAgentError() {
  const status = Number(process.argv[3]);
  if (!Number.isInteger(status) || status === 0) {
    throw new Error(
      `expected OpenClaw agent to fail after Codex uninstall, got status ${process.argv[3]}`,
    );
  }
  const stdout = fs.existsSync("/tmp/openclaw-codex-agent-after-uninstall.json")
    ? readTextFileTail(
        "/tmp/openclaw-codex-agent-after-uninstall.json",
        "post-uninstall agent stdout",
      )
    : "";
  const stderr = fs.existsSync("/tmp/openclaw-codex-agent-after-uninstall.err")
    ? readTextFileTail(
        "/tmp/openclaw-codex-agent-after-uninstall.err",
        "post-uninstall agent stderr",
      )
    : "";
  const combined = `${stdout}\n${stderr}`;
  if (
    !combined.includes('Requested agent harness "codex" is not registered') &&
    !combined.includes("Unknown model: codex/")
  ) {
    throw new Error(`unexpected post-uninstall agent error:\nstdout=${stdout}\nstderr=${stderr}`);
  }
}

const commands = {
  configure,
  "assert-plugin": assertPlugin,
  "assert-npm-deps": assertNpmDeps,
  "print-codex-bin": printCodexBin,
  "assert-preflight": assertPreflight,
  "assert-agent-turn": assertAgentTurn,
  "assert-uninstalled": assertUninstalled,
  "assert-agent-error": assertAgentError,
};

const fn = commands[command];
if (!fn) {
  throw new Error(`unknown codex npm plugin live assertion command: ${command}`);
}
fn();
