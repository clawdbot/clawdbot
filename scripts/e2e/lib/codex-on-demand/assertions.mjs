// Assertions for Codex on-demand plugin E2E scenarios.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assertOpenAiEnvAuthProfileStore } from "../auth-profile-store-assertions.mjs";
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
if (!codexRecord.spec?.includes("@openclaw/codex")) {
  throw new Error(`expected @openclaw/codex install spec, got ${codexRecord.spec}`);
}

const npmRoot = managedNpmRoot();
const installPath = (codexRecord.installPath || "").replace(/^~(?=$|\/)/u, process.env.HOME);
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
const openAiCodexPackage = readJson(openAiCodexPackageJson);
const codexBinPath =
  typeof openAiCodexPackage.bin === "string"
    ? openAiCodexPackage.bin
    : openAiCodexPackage.bin && typeof openAiCodexPackage.bin.codex === "string"
      ? openAiCodexPackage.bin.codex
      : undefined;
if (!codexBinPath) {
  throw new Error(`@openai/codex package has no codex bin: ${openAiCodexPackageJson}`);
}
const codexBin = path.resolve(path.dirname(openAiCodexPackageJson), codexBinPath);
if (!fs.existsSync(codexBin)) {
  throw new Error(`missing managed Codex binary: ${codexBin}`);
}
assertPathInside(npmRoot, codexBin, "managed Codex binary");

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
if (primaryModel !== "openai/gpt-5.6") {
  throw new Error(`expected OpenAI onboarding model openai/gpt-5.6, got ${primaryModel}`);
}
const providerRuntime = cfg.models?.providers?.openai?.agentRuntime?.id;
if (providerRuntime && providerRuntime !== "codex") {
  throw new Error(`unexpected OpenAI provider runtime: ${providerRuntime}`);
}

function readAuthProfileStoreText(agentDir) {
  const dbPath = path.join(agentDir, "openclaw-agent.sqlite");
  if (!fs.existsSync(dbPath)) {
    throw new Error("auth profile SQLite store was not persisted");
  }
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db
      .prepare("SELECT store_json FROM auth_profile_store WHERE store_key = ?")
      .get("primary");
    return typeof row?.store_json === "string" ? row.store_json : "";
  } finally {
    db?.close();
  }
}

const authRaw = readAuthProfileStoreText(path.join(stateDir(), "agents", "main", "agent"));
if (!authRaw) {
  throw new Error("auth profile SQLite store row was not persisted");
}
assertOpenAiEnvAuthProfileStore(authRaw, {
  envRefMessage: "auth profile did not persist OPENAI_API_KEY env ref",
  rawKeyMessage: "auth profile persisted the raw OpenAI test key",
  rawKeyNeedle: "sk-openclaw-codex-on-demand-e2e",
});
