// Crestodian planner Docker harness.
// Imports packaged dist modules so the Docker lane verifies the npm tarball,
// while this small test driver stays mounted from the checkout.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { clearConfigCache } from "../../dist/config/config.js";
import { runCrestodian } from "../../dist/crestodian/crestodian.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertOutputIncludes(output, expected, message) {
  assert(output.includes(expected), `${message}\n\nCaptured Crestodian output:\n${output}`);
}

function createRuntime() {
  const lines = [];
  return {
    lines,
    runtime: {
      log: (...args) => lines.push(args.join(" ")),
      error: (...args) => lines.push(args.join(" ")),
      exit: (code) => {
        throw new Error(`exit ${code}`);
      },
    },
  };
}

async function installFakeClaudeCli(fakeBinDir, promptLogPath) {
  await fs.mkdir(fakeBinDir, { recursive: true });
  const scriptPath = path.join(fakeBinDir, "claude");
  await fs.writeFile(
    scriptPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'if [[ "${1:-}" == "--version" ]]; then',
      '  echo "claude 99.0.0"',
      "  exit 0",
      "fi",
      "IFS= read -r prompt_line || true",
      `printf '%s\\n' "$prompt_line" > ${JSON.stringify(promptLogPath)}`,
      'node -e \'console.log(JSON.stringify({ type: "result", session_id: "fake-claude-session", result: JSON.stringify({ reply: "Fake Claude planner selected a typed model update.", command: "set default model openai/gpt-5.2" }), usage: { input_tokens: 1, output_tokens: 1 } }))\'',
    ].join("\n"),
    { mode: 0o755 },
  );
  await fs.chmod(scriptPath, 0o755);
}

async function main() {
  const stateDir =
    process.env.OPENCLAW_STATE_DIR ??
    (await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-crestodian-planner-")));
  const configPath = process.env.OPENCLAW_CONFIG_PATH ?? path.join(stateDir, "openclaw.json");
  const fakeBinDir = path.join(stateDir, "fake-bin");
  const promptLogPath = path.join(stateDir, "fake-claude-prompt.jsonl");
  process.env.OPENCLAW_STATE_DIR = stateDir;
  process.env.OPENCLAW_CONFIG_PATH = configPath;
  process.env.PATH = `${fakeBinDir}:${process.env.PATH ?? ""}`;
  await fs.rm(stateDir, { recursive: true, force: true });
  await fs.mkdir(stateDir, { recursive: true });
  await installFakeClaudeCli(fakeBinDir, promptLogPath);
  clearConfigCache();

  const runtime = createRuntime();
  await runCrestodian(
    {
      message: "please make the default brain gpt five two",
      yes: true,
      interactive: false,
    },
    runtime.runtime,
  );
  const output = runtime.lines.join("\n");
  assertOutputIncludes(
    output,
    "[crestodian] planner: claude-cli/claude-opus-4-7",
    "configless planner did not use Claude CLI fallback",
  );
  assertOutputIncludes(
    output,
    "Fake Claude planner selected a typed model update.",
    "planner reply was not surfaced",
  );
  assertOutputIncludes(
    output,
    "[crestodian] interpreted: set default model openai/gpt-5.2",
    "planner command was not interpreted",
  );
  assertOutputIncludes(
    output,
    "[crestodian] done: config.setDefaultModel",
    "planned model update did not apply",
  );

  const promptLine = await fs.readFile(promptLogPath, "utf8");
  assert(promptLine.includes("User request:"), "fake Claude CLI did not receive planner prompt");
  assert(
    promptLine.includes("OpenClaw docs:"),
    "planner prompt did not include docs reference context",
  );

  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  assert(
    config.agents?.defaults?.model &&
      typeof config.agents.defaults.model === "object" &&
      "primary" in config.agents.defaults.model &&
      config.agents.defaults.model.primary === "openai/gpt-5.2",
    "planned default model was not written",
  );

  const auditPath = path.join(stateDir, "audit", "crestodian.jsonl");
  const audit = (await fs.readFile(auditPath, "utf8")).trim();
  assert(
    audit.includes('"operation":"config.setDefaultModel"'),
    "planned model update audit entry missing",
  );

  console.log("Crestodian planner Docker E2E passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
