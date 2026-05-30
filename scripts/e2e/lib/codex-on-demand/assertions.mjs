import fs from "node:fs";
import path from "node:path";
import {
  assertPathInside,
  configPath,
  findPackageJson,
  managedNpmRoot,
  npmProjectRootForInstalledPackage,
  readInstallRecords,
  readJson,
  stateDir,
} from "../codex-install-utils.mjs";

const cfg = readJson(configPath());
const inspect = readJson("/tmp/openclaw-codex-inspect.json");
const records = readInstallRecords(cfg.plugins?.installs);
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

const npmRoot = managedNpmRoot();
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

const npmProjectRoot = npmProjectRootForInstalledPackage(installPath, "@openclaw/codex");
const openAiCodexPackageJson = findPackageJson("@openai/codex", [
  installPath,
  npmProjectRoot,
  npmRoot,
]);
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
