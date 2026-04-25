import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCli, shouldStartCrestodianForBareRoot } from "../../src/cli/run-main.js";
import { clearConfigCache } from "../../src/config/config.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { runCrestodian } from "../../src/crestodian/crestodian.js";
import type { RuntimeEnv } from "../../src/runtime.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function createRuntime(): { runtime: RuntimeEnv; lines: string[] } {
  const lines: string[] = [];
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

async function main() {
  const stateDir =
    process.env.OPENCLAW_STATE_DIR ??
    (await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-crestodian-first-run-")));
  const configPath = process.env.OPENCLAW_CONFIG_PATH ?? path.join(stateDir, "openclaw.json");
  process.env.OPENCLAW_STATE_DIR = stateDir;
  process.env.OPENCLAW_CONFIG_PATH = configPath;
  await fs.rm(stateDir, { recursive: true, force: true });
  await fs.mkdir(stateDir, { recursive: true });
  clearConfigCache();

  assert(
    shouldStartCrestodianForBareRoot(["node", "openclaw"]),
    "bare openclaw invocation did not route to Crestodian",
  );
  process.exitCode = undefined;
  await runCli(["node", "openclaw", "onboard", "--modern", "--non-interactive", "--json"]);
  assert(
    process.exitCode === undefined || process.exitCode === 0,
    "modern onboard overview exited nonzero",
  );

  const overviewRuntime = createRuntime();
  await runCrestodian({ message: "overview", interactive: false }, overviewRuntime.runtime);
  const overviewOutput = overviewRuntime.lines.join("\n");
  assert(
    overviewOutput.includes("Config: missing"),
    "fresh overview did not report missing config",
  );
  assert(
    overviewOutput.includes('Next: say "setup" to create a starter config'),
    "fresh overview did not include setup recommendation",
  );

  const setupRuntime = createRuntime();
  await runCrestodian(
    {
      message: "setup workspace /tmp/openclaw-first-run model openai/gpt-5.2",
      yes: true,
      interactive: false,
    },
    setupRuntime.runtime,
  );
  const setupOutput = setupRuntime.lines.join("\n");
  assert(
    setupOutput.includes("[crestodian] done: crestodian.setup"),
    "Crestodian setup did not apply",
  );

  clearConfigCache();
  const validateRuntime = createRuntime();
  await runCrestodian({ message: "validate config", interactive: false }, validateRuntime.runtime);
  assert(
    validateRuntime.lines.join("\n").includes("Config valid:"),
    "post-setup config validation did not pass",
  );

  const config = JSON.parse(await fs.readFile(configPath, "utf8")) as OpenClawConfig;
  assert(
    config.agents?.defaults?.workspace === "/tmp/openclaw-first-run",
    "first-run setup did not write default workspace",
  );
  assert(
    config.agents?.defaults?.model &&
      typeof config.agents.defaults.model === "object" &&
      "primary" in config.agents.defaults.model &&
      config.agents.defaults.model.primary === "openai/gpt-5.2",
    "first-run setup did not write default model",
  );

  const auditPath = path.join(stateDir, "audit", "crestodian.jsonl");
  const audit = (await fs.readFile(auditPath, "utf8")).trim();
  assert(audit.includes('"operation":"crestodian.setup"'), "setup audit entry missing");

  console.log("Crestodian first-run Docker E2E passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
