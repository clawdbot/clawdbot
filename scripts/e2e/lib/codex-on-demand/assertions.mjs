import fs from "node:fs";
import path from "node:path";

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

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

function installRecords() {
  const indexPath = path.join(stateDir(), "plugins", "installs.json");
  const index = fs.existsSync(indexPath) ? readJson(indexPath) : {};
  return index.installRecords || index.records || cfg.plugins?.installs || {};
}

function findPackageJson(packageName, roots) {
  const packagePath = packageName.startsWith("@")
    ? path.join(...packageName.split("/"), "package.json")
    : path.join(packageName, "package.json");
  const candidates = roots.map((root) => path.join(root, "node_modules", packagePath));
  return candidates.find((candidate) => fs.existsSync(candidate));
}

const cfg = readJson(configPath());
const inspect = readJson("/tmp/openclaw-codex-inspect.json");
const records = installRecords();
const codexRecord = records.codex || inspect.install;
if (!codexRecord) {
  throw new Error(`missing codex install record: ${JSON.stringify(records)}`);
}
if (codexRecord.source !== "npm") {
  throw new Error(`expected npm codex install record, got ${codexRecord.source}`);
}
if (!String(codexRecord.spec || "").includes("@openclaw/codex")) {
  throw new Error(`expected @openclaw/codex install spec, got ${codexRecord.spec}`);
}

const npmRoot = path.join(stateDir(), "npm");
const installPath = String(codexRecord.installPath || "").replace(/^~(?=$|\/)/u, process.env.HOME);
if (!installPath) {
  throw new Error(`missing codex installPath: ${JSON.stringify(codexRecord)}`);
}
assertPathInside(npmRoot, installPath, "codex install path");

const codexPackageJson = path.join(installPath, "package.json");
if (!fs.existsSync(codexPackageJson)) {
  throw new Error(`missing npm-installed @openclaw/codex package: ${codexPackageJson}`);
}
const codexPackage = readJson(codexPackageJson);
if (codexPackage.name !== "@openclaw/codex") {
  throw new Error(`unexpected codex package name: ${codexPackage.name}`);
}

const openAiCodexPackageJson = findPackageJson("@openai/codex", [installPath, npmRoot]);
if (!openAiCodexPackageJson) {
  throw new Error("missing @openai/codex dependency under managed npm root");
}
assertPathInside(npmRoot, openAiCodexPackageJson, "@openai/codex dependency");

const list = readJson("/tmp/openclaw-plugins-list.json");
const plugin = (list.plugins || []).find((entry) => entry.id === "codex");
if (!plugin || plugin.enabled !== true || plugin.status !== "loaded") {
  throw new Error(`codex plugin was not enabled+loaded: ${JSON.stringify(plugin)}`);
}

if (inspect.plugin?.id !== "codex" || inspect.plugin?.status !== "loaded") {
  throw new Error(`unexpected codex inspect state: ${JSON.stringify(inspect.plugin)}`);
}
const hasHarness =
  (Array.isArray(inspect.plugin?.agentHarnessIds) &&
    inspect.plugin.agentHarnessIds.includes("codex")) ||
  (Array.isArray(inspect.capabilities) &&
    inspect.capabilities.some(
      (entry) => entry?.kind === "agent-harness" && entry.ids?.includes("codex"),
    ));
if (!hasHarness) {
  throw new Error(`codex harness was not registered: ${JSON.stringify(inspect.plugin)}`);
}

const primaryModel = cfg.agents?.defaults?.model?.primary;
if (primaryModel !== "openai/gpt-5.5") {
  throw new Error(`expected OpenAI onboarding model openai/gpt-5.5, got ${primaryModel}`);
}
const providerRuntime = cfg.models?.providers?.openai?.agentRuntime?.id;
if (providerRuntime && providerRuntime !== "codex") {
  throw new Error(`unexpected OpenAI provider runtime: ${providerRuntime}`);
}

const authPath = path.join(stateDir(), "agents", "main", "agent", "auth-profiles.json");
const authRaw = fs.readFileSync(authPath, "utf8");
if (!authRaw.includes("OPENAI_API_KEY")) {
  throw new Error("auth profile did not persist OPENAI_API_KEY env ref");
}
if (authRaw.includes("sk-openclaw-codex-on-demand-e2e")) {
  throw new Error("auth profile persisted the raw OpenAI test key");
}
