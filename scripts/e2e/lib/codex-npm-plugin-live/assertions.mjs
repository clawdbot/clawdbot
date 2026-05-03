import fs from "node:fs";
import path from "node:path";

const command = process.argv[2];
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const allowBetaCompatDiagnostics =
  process.env.OPENCLAW_CODEX_NPM_PLUGIN_ALLOW_BETA_COMPAT_DIAGNOSTICS === "1";

function stateDir() {
  return process.env.OPENCLAW_STATE_DIR || path.join(process.env.HOME, ".openclaw");
}

function configPath() {
  return process.env.OPENCLAW_CONFIG_PATH || path.join(stateDir(), "openclaw.json");
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
      agentRuntime: { id: "codex", fallback: "none" },
      workspace: path.join(state, "workspace"),
      skipBootstrap: true,
      timeoutSeconds: 420,
    },
  };
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);
}

function readInstallRecord() {
  const indexPath = path.join(stateDir(), "plugins", "installs.json");
  const index = readJson(indexPath);
  const record = (index.installRecords || index.records || {}).codex;
  if (!record) {
    throw new Error("missing codex install record");
  }
  return record;
}

function readInstallRecords() {
  const indexPath = path.join(stateDir(), "plugins", "installs.json");
  if (!fs.existsSync(indexPath)) {
    return {};
  }
  const index = readJson(indexPath);
  return index.installRecords || index.records || {};
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
  const expectedSpec = spec.replace(/^npm:/u, "");
  if (record.source !== "npm") {
    throw new Error(`expected codex npm install record, got source=${record.source}`);
  }
  if (record.spec !== expectedSpec) {
    throw new Error(`expected codex npm spec ${expectedSpec}, got ${record.spec}`);
  }
  if (!record.resolvedVersion || !record.resolvedSpec) {
    throw new Error(`missing codex npm resolution metadata: ${JSON.stringify(record)}`);
  }
}

function managedNpmRoot() {
  return path.join(stateDir(), "npm");
}

function codexInstallPath() {
  const record = readInstallRecord();
  if (typeof record.installPath !== "string" || record.installPath.length === 0) {
    throw new Error(`missing codex installPath: ${JSON.stringify(record)}`);
  }
  return record.installPath.replace(/^~(?=$|\/)/u, process.env.HOME);
}

function findPackageJson(packageName) {
  const parts = packageName.split("/");
  const candidates =
    packageName.startsWith("@") && parts.length === 2
      ? [
          path.join(codexInstallPath(), "node_modules", parts[0], parts[1], "package.json"),
          path.join(managedNpmRoot(), "node_modules", parts[0], parts[1], "package.json"),
        ]
      : [
          path.join(codexInstallPath(), "node_modules", packageName, "package.json"),
          path.join(managedNpmRoot(), "node_modules", packageName, "package.json"),
        ];
  return candidates.find((candidate) => fs.existsSync(candidate));
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

  const openAiCodexPackageJson = findPackageJson("@openai/codex");
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
    path.join(codexInstallPath(), "node_modules", ".bin", commandName),
    path.join(managedNpmRoot(), "node_modules", ".bin", commandName),
  ];
  const candidate = candidates.find((entry) => fs.existsSync(entry));
  if (candidate) {
    return candidate;
  }
  const packageJson = findPackageJson("@openai/codex");
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
  const output = fs.readFileSync("/tmp/openclaw-codex-preflight.log", "utf8");
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
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
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
  const files = roots.flatMap((root) =>
    listFilesRecursive(root).filter((filePath) => filePath.endsWith(".jsonl")),
  );
  if (files.length === 0) {
    throw new Error(
      `missing native Codex session transcript files; checked ${params.roots.join(", ")}`,
    );
  }
  const matchingFile = files.find((filePath) => {
    const content = fs.readFileSync(filePath, "utf8");
    return content.includes(params.marker) || content.includes(params.threadId);
  });
  if (!matchingFile) {
    throw new Error(
      `native Codex session transcripts did not contain ${params.marker} or ${params.threadId}; checked ${files.join(", ")}`,
    );
  }
  assertPathInside(params.codexHome, matchingFile, "native Codex session transcript");
}

function assertAgentTurn() {
  const marker = process.argv[3];
  const sessionId = process.argv[4];
  const modelRef = process.argv[5];
  const stdout = fs.readFileSync("/tmp/openclaw-codex-agent.json", "utf8");
  const stderr = fs.existsSync("/tmp/openclaw-codex-agent.err")
    ? fs.readFileSync("/tmp/openclaw-codex-agent.err", "utf8")
    : "";
  const response = JSON.parse(stdout);
  const text = (response.payloads || []).map((payload) => payload?.text || "").join("\n");
  if (!text.includes(marker)) {
    throw new Error(
      `OpenClaw agent reply did not contain ${marker}:\nstdout=${stdout}\nstderr=${stderr}`,
    );
  }

  const sessionsDir = path.join(stateDir(), "agents", "main", "sessions");
  const storePath = path.join(sessionsDir, "sessions.json");
  const store = readJson(storePath);
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
  if (binding.modelProvider && binding.modelProvider !== "codex") {
    throw new Error(`unexpected Codex binding provider: ${binding.modelProvider}`);
  }

  const codexHome = path.join(stateDir(), "agents", "main", "agent", "codex-home");
  const nativeHome = path.join(codexHome, "home");
  if (!fs.existsSync(codexHome) || !fs.existsSync(nativeHome)) {
    throw new Error(`missing isolated Codex home: ${codexHome}`);
  }
  const codexSessionRoot = path.join(codexHome, "sessions");
  const nativeSessionRoot = path.join(nativeHome, ".codex", "sessions");
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
    ? fs.readFileSync("/tmp/openclaw-codex-agent-after-uninstall.json", "utf8")
    : "";
  const stderr = fs.existsSync("/tmp/openclaw-codex-agent-after-uninstall.err")
    ? fs.readFileSync("/tmp/openclaw-codex-agent-after-uninstall.err", "utf8")
    : "";
  const combined = `${stdout}\n${stderr}`;
  if (!combined.includes('Requested agent harness "codex" is not registered')) {
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
