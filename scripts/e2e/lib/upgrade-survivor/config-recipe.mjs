#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const command = args.shift();

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
]);

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

function runOpenClaw(step) {
  const result = spawnSync("openclaw", step.argv, {
    encoding: "utf8",
    env: process.env,
  });
  return {
    id: step.id,
    intent: step.intent,
    command: ["openclaw", ...step.argv].join(" "),
    status: result.status,
    signal: result.signal,
    ok: result.status === 0,
    stdout: tail(result.stdout),
    stderr: tail(result.stderr),
  };
}

function applyRecipe() {
  const summaryPath = option("--summary");
  const baselineVersion = option("--baseline-version", null);
  const scenario = selectedScenario();
  const scenarioSteps = scenarioConfigSteps.get(scenario) ?? [];
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
    const outcome = runOpenClaw(step);
    summary.steps.push(outcome);
    writeJson(summaryPath, summary);
    if (!outcome.ok) {
      throw new Error(`baseline config recipe failed at ${step.id}`);
    }
  }
}

if (command === "apply") {
  applyRecipe();
} else {
  throw new Error(`unknown upgrade-survivor config-recipe command: ${command ?? "<missing>"}`);
}
