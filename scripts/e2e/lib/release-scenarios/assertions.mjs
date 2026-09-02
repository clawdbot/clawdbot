// Assertions for release scenario E2E packages and plugin state.
import fs from "node:fs";
import path from "node:path";
import {
  assertAgentReplyContainsMarker,
  assertOpenAiRequestLogUsed,
} from "../agent-turn-output.mjs";
import {
  assertNoLegacyPrimaryAuthRows,
  assertOpenAiEnvAuthProfileStore,
  readSharedAuthProfileStoreText,
} from "../auth-profile-store-assertions.mjs";
import {
  applyMockOpenAiModelConfig,
  parseMockOpenAiPort,
} from "../fixtures/mock-openai-config.mjs";
import { readPluginInstallRecords } from "../plugin-index-sqlite.mjs";
import { isExplicitPluginDisableMarker } from "../plugin-uninstall-assertions.mjs";
import {
  ERROR_DETAIL_TAIL_BYTES,
  fileContainsText,
  readJson,
} from "../release-assertion-files.mjs";
import { readTextFileTail } from "../text-file-utils.mjs";

const command = process.argv[2];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
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

function stateDir() {
  return process.env.OPENCLAW_STATE_DIR ?? path.dirname(configPath());
}

function readStateText() {
  const paths = [configPath(), authProfilesPath()].filter((file) => fs.existsSync(file));
  return [
    ...paths.map((file) => fs.readFileSync(file, "utf8")),
    readSharedAuthProfileStoreText(stateDir()),
  ]
    .filter(Boolean)
    .join("\n");
}

function configureMockOpenAi() {
  const mockPort = parseMockOpenAiPort(process.argv[3]);
  const cfg = readJson(configPath());
  applyMockOpenAiModelConfig(cfg, { mockPort, includeImageDefaults: true });
  writeConfig(cfg);
}

function assertOpenAiEnvRef() {
  const rawKey = process.argv[3];
  assert(fs.existsSync(configPath()), "openclaw.json missing");
  assertNoLegacyPrimaryAuthRows(stateDir());
  assertOpenAiEnvAuthProfileStore(readSharedAuthProfileStoreText(stateDir()), {
    missingMessage: "OpenAI env ref was not persisted",
    envRefMessage: "OpenAI env ref was not persisted",
    rawKeyMessage: "raw OpenAI key was persisted",
    rawKeyNeedle: rawKey,
  });
  assert(!readStateText().includes(rawKey), "raw OpenAI key was persisted");
}

function summarizeKnownValue(value, knownValues) {
  if (value === undefined) {
    return "missing";
  }
  return knownValues.includes(value) ? value : "unexpected";
}

function summarizeBoolean(value) {
  if (value === true || value === false) {
    return value;
  }
  return value === undefined ? "missing" : "unexpected";
}

function sessionMemoryHookConfigProjection(cfg) {
  const wizard = cfg?.wizard;
  const hooks = cfg?.hooks;
  const internal = hooks?.internal;
  const sessionMemory = internal?.entries?.["session-memory"];
  return {
    wizard: {
      present: wizard !== undefined,
      lastRunCommand: summarizeKnownValue(wizard?.lastRunCommand, ["onboard", "configure"]),
      lastRunMode: summarizeKnownValue(wizard?.lastRunMode, ["local", "remote"]),
    },
    hooks: {
      present: hooks !== undefined,
      internalPresent: internal !== undefined,
      internalEnabled: summarizeBoolean(internal?.enabled),
      sessionMemoryPresent: sessionMemory !== undefined,
      sessionMemoryEnabled: summarizeBoolean(sessionMemory?.enabled),
    },
  };
}

function assertSessionMemoryHookEnabled() {
  const cfg = readJson(configPath());
  if (cfg?.hooks?.internal?.entries?.["session-memory"]?.enabled === true) {
    return;
  }
  throw new Error(
    `session-memory hook was not enabled. Onboarding config projection: ${JSON.stringify(
      sessionMemoryHookConfigProjection(cfg),
    )}`,
  );
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
  const installRecords = readPluginInstallRecords({ configPath: configPath() });
  assert(!installRecords[pluginId], `install record still present for ${pluginId}`);
  assert(
    isExplicitPluginDisableMarker(cfg, pluginId),
    `exact disabled uninstall marker missing for ${pluginId}`,
  );
  const managedRoot = path.join(
    process.env.HOME ?? "",
    ".openclaw",
    "plugins",
    "installed",
    pluginId,
  );
  assert(!fs.existsSync(managedRoot), `managed plugin directory still present: ${managedRoot}`);
  if (cliRoot) {
    const list = JSON.stringify(installRecords);
    assert(!list.includes(cliRoot), `install records still mention CLI root ${cliRoot}`);
  }
}

const commands = {
  "configure-mock-openai": configureMockOpenAi,
  "assert-openai-env-ref": assertOpenAiEnvRef,
  "assert-session-memory-hook-enabled": assertSessionMemoryHookEnabled,
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
