#!/usr/bin/env node
// Builds config recipes for upgrade-survivor E2E scenarios.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseReleaseVersion } from "../../../lib/npm-publish-plan.mjs";
import { buildCmdExeCommandLine, resolveWindowsCmdExePath } from "../../../windows-cmd-helpers.mjs";

const args = process.argv.slice(2);
const command = args.shift();
export const CONFIG_COMMAND_TIMEOUT_MS = 120_000;
export const CONFIG_COMMAND_MAX_BUFFER_BYTES = 4 * 1024 * 1024;

function option(name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) {
    return fallback;
  }
  const value = args[index + 1];
  if (!value) {
    throw new Error(`missing value for ${name}`);
  }
  return value;
}

function tail(value, max = 2400) {
  const text = String(value || "");
  return text.length <= max ? text : text.slice(-max);
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

const configSectionDir = new URL("./config-recipe/", import.meta.url);

function readConfigSection(fileName) {
  const fileUrl = new URL(fileName, configSectionDir);
  return JSON.stringify(JSON.parse(fs.readFileSync(fileUrl, "utf8")));
}

export function isReleaseBefore(version, minimum) {
  const parsed = parseReleaseVersion(String(version ?? ""));
  const minimumParsed = parseReleaseFloor(minimum);
  if (!parsed || !minimumParsed) {
    return false;
  }
  for (const key of ["year", "month", "patch"]) {
    const delta = parsed[key] - minimumParsed[key];
    if (delta !== 0) {
      return delta < 0;
    }
  }
  return false;
}

function parseReleaseFloor(version) {
  const match = /^([0-9]{4})\.([1-9][0-9]?)\.([0-9]+)$/u.exec(String(version ?? ""));
  if (!match) {
    return null;
  }
  const [year, month, patch] = match.slice(1).map((part) => Number(part));
  if (
    !Number.isSafeInteger(year) ||
    !Number.isSafeInteger(month) ||
    !Number.isSafeInteger(patch) ||
    month < 1 ||
    month > 12
  ) {
    return null;
  }
  return { year, month, patch };
}

function configSetJsonFile(id, intent, configPath, fileName) {
  return {
    id,
    intent,
    argv: ["config", "set", configPath, readConfigSection(fileName), "--strict-json"],
  };
}

const representativeConfigSteps = [
  configSetJsonFile("models-openai", "models", "models.providers.openai", "models-openai.json"),
  configSetJsonFile("agents", "agents", "agents", "agents.json"),
  configSetJsonFile("skills", "skills", "skills", "skills.json"),
  configSetJsonFile("plugins", "plugins", "plugins", "plugins.json"),
  configSetJsonFile(
    "channels-discord",
    "discord-channel",
    "channels.discord",
    "channels-discord.json",
  ),
  configSetJsonFile(
    "channels-telegram",
    "telegram-channel",
    "channels.telegram",
    "channels-telegram.json",
  ),
  configSetJsonFile(
    "channels-whatsapp",
    "whatsapp-channel",
    "channels.whatsapp",
    "channels-whatsapp.json",
  ),
];

const scenarioConfigSteps = new Map([
  [
    "acpx-openclaw-tools-bridge",
    [
      configSetJsonFile(
        "plugins-acpx-openclaw-tools-bridge",
        "acpx-openclaw-tools-bridge",
        "plugins",
        "plugins-acpx-openclaw-tools-bridge.json",
      ),
    ],
  ],
  [
    "feishu-channel",
    [
      configSetJsonFile("plugins-feishu", "plugins", "plugins", "plugins-feishu.json"),
      configSetJsonFile(
        "channels-feishu",
        "feishu-channel",
        "channels.feishu",
        "channels-feishu.json",
      ),
    ],
  ],
  [
    "tilde-log-path",
    [
      {
        id: "logging-file",
        intent: "logging",
        argv: ["config", "set", "logging.file", "~/openclaw-upgrade-survivor/gateway.jsonl"],
      },
    ],
  ],
  [
    "configured-plugin-installs",
    [
      configSetJsonFile(
        "plugins-configured-installs",
        "configured-plugin-installs",
        "plugins",
        "plugins-configured-installs.json",
      ),
      {
        id: "channels-whatsapp-unset",
        intent: "configured-plugin-installs",
        argv: ["config", "unset", "channels.whatsapp"],
      },
      configSetJsonFile(
        "channels-matrix",
        "configured-plugin-installs",
        "channels.matrix",
        "channels-matrix.json",
      ),
    ],
  ],
  [
    "codex-allowlist-survival",
    [
      {
        id: "plugins-codex-allowlist",
        intent: "codex-allowlist-survival",
        argv: [
          "config",
          "set",
          "plugins.allow",
          JSON.stringify(["discord", "memory", "telegram", "whatsapp", "codex"]),
          "--strict-json",
        ],
      },
    ],
  ],
]);

export function resolveScenarioConfigSteps(scenario) {
  return scenarioConfigSteps.get(scenario) ?? [];
}

const recipe = [
  {
    id: "update-channel",
    intent: "update",
    argv: ["config", "set", "update.channel", "stable"],
  },
  configSetJsonFile("gateway", "gateway", "gateway", "gateway.json"),
  ...representativeConfigSteps,
  {
    id: "validate",
    intent: "validate",
    argv: ["config", "validate"],
  },
];

function selectedScenario() {
  return process.env.OPENCLAW_UPGRADE_SURVIVOR_SCENARIO || "base";
}

function adaptStepForBaseline(step, baselineVersion, summary) {
  if (
    step.intent === "acpx-openclaw-tools-bridge" &&
    isReleaseBefore(baselineVersion, "2026.4.22")
  ) {
    if (!summary.skippedIntents.includes("acpx-openclaw-tools-bridge")) {
      summary.skippedIntents.push("acpx-openclaw-tools-bridge");
    }
    return null;
  }
  if (!isReleaseBefore(baselineVersion, "2026.4.0")) {
    return step;
  }
  if (step.id === "plugins-feishu" || step.id === "channels-feishu") {
    if (!summary.skippedIntents.includes("feishu-channel")) {
      summary.skippedIntents.push("feishu-channel");
    }
    return null;
  }
  if (step.id === "agents") {
    const agents = JSON.parse(step.argv[3]);
    delete agents.defaults?.skills;
    for (const agent of agents.list ?? []) {
      delete agent.thinkingDefault;
      delete agent.fastModeDefault;
      delete agent.skills;
    }
    summary.skippedIntents.push("agent-modern-preferences");
    return {
      ...step,
      argv: [...step.argv.slice(0, 3), JSON.stringify(agents), ...step.argv.slice(4)],
    };
  }
  if (step.intent === "plugins") {
    const plugins = JSON.parse(step.argv[3]);
    plugins.allow = (plugins.allow ?? []).filter((id) => id !== "memory");
    delete plugins.entries?.memory;
    if (!summary.skippedIntents.includes("memory-plugin-allow")) {
      summary.skippedIntents.push("memory-plugin-allow");
    }
    return {
      ...step,
      argv: [...step.argv.slice(0, 3), JSON.stringify(plugins), ...step.argv.slice(4)],
    };
  }
  return step;
}

export function resolveUpgradeSurvivorOpenClawCommand(argv, params = {}) {
  const platform = params.platform ?? process.platform;
  if (platform === "win32") {
    const comSpec = params.comSpec ?? resolveWindowsCmdExePath(params.env ?? process.env);
    return {
      command: comSpec,
      args: ["/d", "/s", "/c", buildCmdExeCommandLine("openclaw.cmd", argv)],
      commandLabel: ["openclaw", ...argv].join(" "),
      shell: false,
      windowsVerbatimArguments: true,
    };
  }
  return {
    command: "openclaw",
    args: argv,
    commandLabel: ["openclaw", ...argv].join(" "),
    shell: false,
  };
}

function errorCode(error) {
  return error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
}

export function runUpgradeSurvivorOpenClawStep(step, params = {}) {
  const invocation = resolveUpgradeSurvivorOpenClawCommand(step.argv);
  const run = params.spawnSyncCommand ?? spawnSync;
  const timeoutMs = params.timeoutMs ?? CONFIG_COMMAND_TIMEOUT_MS;
  const maxBuffer = params.maxBufferBytes ?? CONFIG_COMMAND_MAX_BUFFER_BYTES;
  const result = run(invocation.command, invocation.args, {
    encoding: "utf8",
    env: process.env,
    killSignal: "SIGTERM",
    maxBuffer,
    shell: invocation.shell,
    timeout: timeoutMs,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  const code = errorCode(result.error);
  return {
    id: step.id,
    intent: step.intent,
    command: invocation.commandLabel,
    status: result.status,
    signal: result.signal,
    ok: result.status === 0 && !result.error,
    errorCode: code,
    errorMessage: result.error?.message ? tail(result.error.message) : undefined,
    stdout: tail(result.stdout),
    stderr: tail(result.stderr),
  };
}

function applyRecipe() {
  const summaryPath = option("--summary");
  const baselineVersion = option("--baseline-version", null);
  const scenario = selectedScenario();
  const scenarioSteps = resolveScenarioConfigSteps(scenario);
  const summary = {
    source: "baseline-cli-command-recipe",
    recipe: "upgrade-survivor-v1",
    baselineVersion,
    scenario,
    acceptedIntents: [
      "update",
      "gateway",
      "models",
      "agents",
      "skills",
      "plugins",
      "discord-channel",
      "telegram-channel",
      "whatsapp-channel",
      ...scenarioSteps.map((step) => step.intent),
    ],
    skippedIntents: [],
    steps: [],
  };

  for (const step of [...recipe.slice(0, -1), ...scenarioSteps, recipe.at(-1)]) {
    const adaptedStep = adaptStepForBaseline(step, baselineVersion, summary);
    if (!adaptedStep) {
      continue;
    }
    const outcome = runUpgradeSurvivorOpenClawStep(adaptedStep);
    summary.steps.push(outcome);
    writeJson(summaryPath, summary);
    if (!outcome.ok) {
      const detail = outcome.errorCode ?? outcome.signal ?? outcome.status ?? "unknown";
      throw new Error(`baseline config recipe failed at ${step.id}: ${detail}`);
    }
  }
}

function main() {
  if (command === "apply") {
    applyRecipe();
  } else {
    throw new Error(`unknown upgrade-survivor config-recipe command: ${command ?? "<missing>"}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
