import fs from "node:fs";
import path from "node:path";
import {
  assertAgentReplyContainsMarker,
  assertOpenAiRequestLogUsed,
} from "../agent-turn-output.mjs";
import { applyMockOpenAiModelConfig } from "../fixtures/mock-openai-config.mjs";
import { readTextFileTail } from "../text-file-utils.mjs";

const command = process.argv[2];

const SCAN_CHUNK_BYTES = 64 * 1024;
const SCAN_CARRY_CHARS = 256;
const ERROR_DETAIL_TAIL_BYTES = 16 * 1024;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function fileContainsText(file, needle) {
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
    let carry = "";
    let offset = 0;
    while (offset < stat.size) {
      const bytesToRead = Math.min(buffer.length, stat.size - offset);
      const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, offset);
      if (bytesRead <= 0) {
        break;
      }
      offset += bytesRead;
      const text = carry + buffer.subarray(0, bytesRead).toString("utf8");
      if (text.includes(needle)) {
        return true;
      }
      carry = text.slice(-Math.max(SCAN_CARRY_CHARS, needle.length - 1));
    }
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

function configPath() {
  return (
    process.env.OPENCLAW_CONFIG_PATH ??
    path.join(process.env.HOME ?? "", ".openclaw", "openclaw.json")
  );
}

function writeConfig(cfg) {
  fs.writeFileSync(configPath(), `${JSON.stringify(cfg, null, 2)}\n`);
}

function authProfilesPath() {
  return path.join(
    process.env.HOME ?? "",
    ".openclaw",
    "agents",
    "main",
    "agent",
    "auth-profiles.json",
  );
}

function readStateText() {
  const paths = [configPath(), authProfilesPath()].filter((file) => fs.existsSync(file));
  return paths.map((file) => fs.readFileSync(file, "utf8")).join("\n");
}

function configureMockOpenAi() {
  const mockPort = Number(process.argv[3]);
  const cfg = readJson(configPath());
  applyMockOpenAiModelConfig(cfg, { mockPort, includeImageDefaults: true });
  writeConfig(cfg);
}

function assertOpenAiEnvRef() {
  const rawKey = process.argv[3];
  const state = readStateText();
  assert(state.includes("OPENAI_API_KEY"), "OpenAI env ref was not persisted");
  assert(!state.includes(rawKey), "raw OpenAI key was persisted");
  assert(fs.existsSync(configPath()), "openclaw.json missing");
}

function assertAgentTurn() {
  const marker = process.argv[3];
  const outputPath = process.argv[4];
  const requestLogPath = process.argv[5];
  assertAgentReplyContainsMarker(marker, outputPath);
  assertOpenAiRequestLogUsed(requestLogPath, "mock OpenAI");
}

function assertFileContains() {
  const file = process.argv[3];
  const needle = process.argv[4];
  assert(
    fileContainsText(file, needle),
    `${file} did not contain ${needle}. Output tail: ${readTextFileTail(file, ERROR_DETAIL_TAIL_BYTES)}`,
  );
}

function assertPackageVersion() {
  const packageRoot = process.argv[3];
  const expectedVersion = process.argv[4];
  const label = process.argv[5] ?? "package";
  assert(packageRoot, "missing package root");
  assert(expectedVersion, "missing expected package version");
  const packageJsonPath = path.join(packageRoot, "package.json");
  const packageJson = readJson(packageJsonPath);
  assert(
    packageJson.version === expectedVersion,
    `${label} package version mismatch: expected ${expectedVersion}, got ${packageJson.version}`,
  );
}

function assertImageDescribe() {
  const outputPath = process.argv[3];
  const requestLogPath = process.argv[4];
  const payload = readJson(outputPath);
  assert(payload.ok === true, `image describe failed: ${JSON.stringify(payload)}`);
  assert(payload.capability === "image.describe", "wrong image describe capability");
  const output = payload.outputs?.[0];
  assert(output?.text?.includes("OPENCLAW_E2E_OK"), "image description marker missing");
  assert(output.provider === "openai", `unexpected image provider: ${output?.provider}`);
  assert(
    fileContainsText(requestLogPath, "/v1/responses"),
    "image describe did not hit Responses API",
  );
}

function assertImageGenerate() {
  const outputPath = process.argv[3];
  const requestLogPath = process.argv[4];
  const payload = readJson(outputPath);
  assert(payload.ok === true, `image generation failed: ${JSON.stringify(payload)}`);
  assert(payload.capability === "image.generate", "wrong image generation capability");
  const output = payload.outputs?.[0];
  assert(output?.path && fs.existsSync(output.path), `generated image missing: ${output?.path}`);
  assert(output.mimeType === "image/png", `unexpected generated mime type: ${output.mimeType}`);
  assert(payload.provider === "openai", `unexpected generation provider: ${payload.provider}`);
  assert(
    fileContainsText(requestLogPath, "/v1/images/generations"),
    "image generation endpoint was not used",
  );
}

function assertMemorySearch() {
  const outputPath = process.argv[3];
  const needle = process.argv[4];
  const payload = readJson(outputPath);
  const haystack = JSON.stringify(payload);
  assert(haystack.includes(needle), `memory search missed ${needle}: ${haystack}`);
}

function assertPluginUninstalled() {
  const pluginId = process.argv[3];
  const cliRoot = process.argv[4];
  const cfg = readJson(configPath());
  const recordsPath = path.join(process.env.HOME ?? "", ".openclaw", "plugins", "installs.json");
  const records = fs.existsSync(recordsPath) ? readJson(recordsPath) : {};
  const installRecords = records.installRecords ?? records.records ?? {};
  assert(!installRecords[pluginId], `install record still present for ${pluginId}`);
  assert(!cfg.plugins?.entries?.[pluginId], `plugin config entry still present for ${pluginId}`);
  const managedRoot = path.join(
    process.env.HOME ?? "",
    ".openclaw",
    "plugins",
    "installed",
    pluginId,
  );
  assert(!fs.existsSync(managedRoot), `managed plugin directory still present: ${managedRoot}`);
  if (cliRoot) {
    const list = JSON.stringify(records);
    assert(!list.includes(cliRoot), `install records still mention CLI root ${cliRoot}`);
  }
}

const commands = {
  "configure-mock-openai": configureMockOpenAi,
  "assert-openai-env-ref": assertOpenAiEnvRef,
  "assert-agent-turn": assertAgentTurn,
  "assert-file-contains": assertFileContains,
  "assert-package-version": assertPackageVersion,
  "assert-image-describe": assertImageDescribe,
  "assert-image-generate": assertImageGenerate,
  "assert-memory-search": assertMemorySearch,
  "assert-plugin-uninstalled": assertPluginUninstalled,
};

const fn = commands[command];
if (!fn) {
  throw new Error(`unknown release scenario assertion command: ${command ?? "<missing>"}`);
}
await fn();
