#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DEFAULT_LABEL = "state";
const DEFAULT_SCENARIO = "empty";
const SCENARIOS = new Set([
  "empty",
  "minimal",
  "update-stable",
  "gateway-loopback",
  "external-service",
]);

function usage() {
  return `Usage:
  node scripts/lib/openclaw-test-state.mjs -- create [--label <name>] [--scenario <name>] [--env-file <path>] [--json]
  node scripts/lib/openclaw-test-state.mjs shell [--label <name>] [--scenario <name>]
  node scripts/lib/openclaw-test-state.mjs shell-function

Scenarios: ${[...SCENARIOS].join(", ")}
`;
}

function parseArgs(argv) {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const [command, ...rest] = args;
  if (!command || command === "--help" || command === "-h") {
    return { command: "help", options: {} };
  }
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (
      arg === "--label" ||
      arg === "--scenario" ||
      arg === "--env-file" ||
      arg === "--port" ||
      arg === "--token"
    ) {
      const value = rest[index + 1];
      if (!value) {
        throw new Error(`missing value for ${arg}`);
      }
      index += 1;
      options[arg.slice(2)] = value;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return { command, options };
}

function normalizeLabel(value) {
  return (
    String(value || DEFAULT_LABEL)
      .replace(/[^A-Za-z0-9_.-]+/gu, "-")
      .replace(/^-+|-+$/gu, "") || DEFAULT_LABEL
  );
}

function requireScenario(value) {
  const scenario = value || DEFAULT_SCENARIO;
  if (!SCENARIOS.has(scenario)) {
    throw new Error(`unknown scenario: ${scenario}`);
  }
  return scenario;
}

function scenarioConfig(scenario, options = {}) {
  if (scenario === "minimal" || scenario === "external-service") {
    return {};
  }
  if (scenario === "update-stable") {
    return {
      update: {
        channel: "stable",
      },
      plugins: {},
    };
  }
  if (scenario === "gateway-loopback") {
    return {
      gateway: {
        port: Number(options.port || 18789),
        auth: {
          mode: "token",
          token: options.token || "openclaw-test-token",
        },
        controlUi: {
          enabled: false,
        },
      },
    };
  }
  return undefined;
}

function scenarioEnv(scenario) {
  if (scenario === "external-service") {
    return {
      OPENCLAW_SERVICE_REPAIR_POLICY: "external",
    };
  }
  return {};
}

function shellQuote(value) {
  return `'${String(value).replace(/'/gu, `'\\''`)}'`;
}

function renderExports(env) {
  return Object.entries(env)
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
    .join("\n");
}

function renderConfigWrite(configPathExpression, config) {
  if (config === undefined) {
    return "";
  }
  const json = JSON.stringify(config, null, 2);
  return [
    `cat > ${configPathExpression} <<'OPENCLAW_TEST_STATE_JSON'`,
    json,
    "OPENCLAW_TEST_STATE_JSON",
  ].join("\n");
}

function buildCreatePlan(options = {}) {
  const label = normalizeLabel(options.label);
  const scenario = requireScenario(options.scenario);
  if (!options.root) {
    throw new Error("buildCreatePlan requires root");
  }
  const root = options.root;
  const home = path.join(root, "home");
  const stateDir = path.join(home, ".openclaw");
  const configPath = path.join(stateDir, "openclaw.json");
  const workspaceDir = path.join(home, "workspace");
  const config = scenarioConfig(scenario, options);
  const env = {
    HOME: home,
    USERPROFILE: home,
    OPENCLAW_HOME: home,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
    ...scenarioEnv(scenario),
  };
  return {
    label,
    scenario,
    root,
    home,
    stateDir,
    configPath,
    workspaceDir,
    env,
    hasConfig: config !== undefined,
    config,
  };
}

export async function createState(options = {}) {
  const label = normalizeLabel(options.label);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `openclaw-${label}-`));
  const plan = buildCreatePlan({ ...options, root });
  await fs.mkdir(plan.stateDir, { recursive: true });
  await fs.mkdir(plan.workspaceDir, { recursive: true });
  if (plan.config !== undefined) {
    await fs.writeFile(plan.configPath, `${JSON.stringify(plan.config, null, 2)}\n`, "utf8");
  }
  return plan;
}

export function renderEnvFile(plan) {
  return `${renderExports(plan.env)}\n`;
}

export function renderShellSnippet(options = {}) {
  const label = normalizeLabel(options.label);
  const scenario = requireScenario(options.scenario);
  const config = scenarioConfig(scenario, options);
  const env = scenarioEnv(scenario);
  const template = `/tmp/openclaw-${label}-${scenario}-home.XXXXXX`;
  const lines = [
    `OPENCLAW_TEST_STATE_HOME="$(mktemp -d ${shellQuote(template)})"`,
    'export HOME="$OPENCLAW_TEST_STATE_HOME"',
    'export USERPROFILE="$OPENCLAW_TEST_STATE_HOME"',
    'export OPENCLAW_HOME="$OPENCLAW_TEST_STATE_HOME"',
    'export OPENCLAW_STATE_DIR="$OPENCLAW_TEST_STATE_HOME/.openclaw"',
    'export OPENCLAW_CONFIG_PATH="$OPENCLAW_STATE_DIR/openclaw.json"',
    'export OPENCLAW_TEST_WORKSPACE_DIR="$OPENCLAW_TEST_STATE_HOME/workspace"',
    'mkdir -p "$OPENCLAW_STATE_DIR" "$OPENCLAW_TEST_WORKSPACE_DIR"',
  ];
  for (const [key, value] of Object.entries(env)) {
    lines.push(`export ${key}=${shellQuote(value)}`);
  }
  const configWrite = renderConfigWrite('"$OPENCLAW_CONFIG_PATH"', config);
  if (configWrite) {
    lines.push(configWrite);
  }
  return `${lines.join("\n")}\n`;
}

export function renderShellFunction() {
  return `openclaw_test_state_create() {
  local raw_label="\${1:-state}"
  local label="$raw_label"
  local scenario="\${2:-empty}"
  case "$scenario" in
    empty|minimal|update-stable|gateway-loopback|external-service) ;;
    *)
      echo "unknown OpenClaw test-state scenario: $scenario" >&2
      return 1
      ;;
  esac
  case "$raw_label" in
    /*)
      OPENCLAW_TEST_STATE_HOME="$raw_label"
      mkdir -p "$OPENCLAW_TEST_STATE_HOME"
      ;;
    *)
      label="$(printf "%s" "$label" | tr -cs "A-Za-z0-9_.-" "-" | sed -e "s/^-*//" -e "s/-*$//")"
      [ -n "$label" ] || label="state"
      OPENCLAW_TEST_STATE_HOME="$(mktemp -d "/tmp/openclaw-$label-$scenario-home.XXXXXX")"
      ;;
  esac
  export HOME="$OPENCLAW_TEST_STATE_HOME"
  export USERPROFILE="$OPENCLAW_TEST_STATE_HOME"
  export OPENCLAW_HOME="$OPENCLAW_TEST_STATE_HOME"
  export OPENCLAW_STATE_DIR="$OPENCLAW_TEST_STATE_HOME/.openclaw"
  export OPENCLAW_CONFIG_PATH="$OPENCLAW_STATE_DIR/openclaw.json"
  export OPENCLAW_TEST_WORKSPACE_DIR="$OPENCLAW_TEST_STATE_HOME/workspace"
  unset OPENCLAW_AGENT_DIR
  unset PI_CODING_AGENT_DIR
  unset OPENCLAW_SERVICE_REPAIR_POLICY
  mkdir -p "$OPENCLAW_STATE_DIR" "$OPENCLAW_TEST_WORKSPACE_DIR"
  case "$scenario" in
    minimal)
      cat > "$OPENCLAW_CONFIG_PATH" <<'OPENCLAW_TEST_STATE_JSON'
{}
OPENCLAW_TEST_STATE_JSON
      ;;
    update-stable)
      cat > "$OPENCLAW_CONFIG_PATH" <<'OPENCLAW_TEST_STATE_JSON'
{
  "update": {
    "channel": "stable"
  },
  "plugins": {}
}
OPENCLAW_TEST_STATE_JSON
      ;;
    gateway-loopback)
      cat > "$OPENCLAW_CONFIG_PATH" <<'OPENCLAW_TEST_STATE_JSON'
{
  "gateway": {
    "port": 18789,
    "auth": {
      "mode": "token",
      "token": "openclaw-test-token"
    },
    "controlUi": {
      "enabled": false
    }
  }
}
OPENCLAW_TEST_STATE_JSON
      ;;
    external-service)
      export OPENCLAW_SERVICE_REPAIR_POLICY="external"
      cat > "$OPENCLAW_CONFIG_PATH" <<'OPENCLAW_TEST_STATE_JSON'
{}
OPENCLAW_TEST_STATE_JSON
      ;;
  esac
}
`;
}

async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseArgs(argv);
  if (command === "help") {
    process.stdout.write(usage());
    return;
  }
  if (command === "shell") {
    process.stdout.write(renderShellSnippet(options));
    return;
  }
  if (command === "shell-function") {
    process.stdout.write(renderShellFunction());
    return;
  }
  if (command === "create") {
    const plan = await createState(options);
    if (options["env-file"]) {
      await fs.writeFile(options["env-file"], renderEnvFile(plan), "utf8");
    }
    if (options.json) {
      process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    }
    return;
  }
  throw new Error(`unknown command: ${command}`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.stderr.write(usage());
    process.exitCode = 1;
  });
}
