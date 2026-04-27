// Crestodian first-run Docker harness.
// Imports packaged dist modules so the Docker lane verifies the npm tarball,
// while this small test driver stays mounted from the checkout.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCli, shouldStartCrestodianForBareRoot } from "../../dist/cli/run-main.js";
import { clearConfigCache } from "../../dist/config/config.js";
import type { OpenClawConfig } from "../../dist/config/types.openclaw.js";
import { runCrestodian } from "../../dist/crestodian/crestodian.js";
import type { RuntimeEnv } from "../../dist/runtime.js";

type CrestodianFirstRunCommand = {
  id: string;
  message: string;
  expectOutput: string;
  approve: boolean;
};

type CrestodianFirstRunSpec = {
  dockerDefaultWorkspace: string;
  dockerAgentWorkspace: string;
  agentId: string;
  model: string;
  discordEnv: string;
  discordToken: string;
  commands: CrestodianFirstRunCommand[];
  auditOperations: string[];
};

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

async function readFirstRunSpec(): Promise<CrestodianFirstRunSpec> {
  return JSON.parse(
    await fs.readFile(
      path.join(process.cwd(), "scripts", "e2e", "crestodian-first-run-spec.json"),
      "utf8",
    ),
  ) as CrestodianFirstRunSpec;
}

function renderCommandTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, key: string) => vars[key] ?? match);
}

async function main() {
  const spec = await readFirstRunSpec();
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
    overviewOutput.includes('Next: run "setup" to create a starter config'),
    "fresh overview did not include setup recommendation",
  );

  process.env[spec.discordEnv] = spec.discordToken;

  const commandVars = {
    defaultWorkspace: spec.dockerDefaultWorkspace,
    agentWorkspace: spec.dockerAgentWorkspace,
    agentId: spec.agentId,
    model: spec.model,
    discordEnv: spec.discordEnv,
  };
  for (const command of spec.commands) {
    clearConfigCache();
    const commandRuntime = createRuntime();
    await runCrestodian(
      {
        message: renderCommandTemplate(command.message, commandVars),
        yes: command.approve,
        interactive: false,
      },
      commandRuntime.runtime,
    );
    const output = commandRuntime.lines.join("\n");
    assert(
      output.includes(command.expectOutput),
      `Crestodian first-run command ${command.id} did not apply: ${output}`,
    );
  }

  const config = JSON.parse(await fs.readFile(configPath, "utf8")) as OpenClawConfig;
  assert(
    config.agents?.defaults?.workspace === spec.dockerDefaultWorkspace,
    "first-run setup did not write default workspace",
  );
  assert(
    config.agents?.defaults?.model &&
      typeof config.agents.defaults.model === "object" &&
      "primary" in config.agents.defaults.model &&
      config.agents.defaults.model.primary === spec.model,
    "first-run setup did not write default model",
  );
  const reef = config.agents?.list?.find((agent) => agent.id === spec.agentId);
  assert(reef, "Crestodian did not create reef agent");
  assert(reef.workspace === spec.dockerAgentWorkspace, "Crestodian did not write reef workspace");
  assert(reef.model === spec.model, "Crestodian did not write reef model");
  assert(config.plugins?.allow?.includes("discord"), "Crestodian did not allow Discord plugin");
  assert(
    config.plugins?.entries?.discord?.enabled === true,
    "Crestodian did not enable Discord plugin entry",
  );
  assert(config.channels?.discord?.enabled === true, "Crestodian did not enable Discord");
  const discordToken = config.channels?.discord?.token;
  assert(
    discordToken &&
      typeof discordToken === "object" &&
      "source" in discordToken &&
      discordToken.source === "env" &&
      "id" in discordToken &&
      discordToken.id === spec.discordEnv,
    "Crestodian did not write Discord token SecretRef",
  );
  assert(
    !JSON.stringify(config.channels.discord).includes(spec.discordToken),
    "Crestodian persisted the raw Discord token",
  );

  const auditPath = path.join(stateDir, "audit", "crestodian.jsonl");
  const audit = (await fs.readFile(auditPath, "utf8")).trim();
  for (const operation of spec.auditOperations) {
    assert(audit.includes(`"operation":"${operation}"`), `${operation} audit entry missing`);
  }

  console.log("Crestodian first-run Docker E2E passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
