// OpenClaw first-run Docker harness.
// Imports packaged dist modules so the Docker lane verifies the npm tarball,
// while this small test driver stays mounted from the checkout.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { shouldStartOnboardingForFreshInstall } from "../../../../dist/cli/run-main.js";
import { clearConfigCache } from "../../../../dist/config/config.js";
import type { OpenClawConfig } from "../../../../dist/config/types.openclaw.js";
import type { RuntimeEnv } from "../../../../dist/runtime.js";
import { activateSetupInference } from "../../../../dist/system-agent/setup-inference.js";
import { createE2eStateDir } from "../../../../scripts/e2e/lib/temp-state-dir.ts";

type SystemAgentFirstRunCommand = {
  id: string;
  message: string;
  expectOutput: string;
  approve: boolean;
  planner?: boolean;
};

type SystemAgentFirstRunSpec = {
  dockerDefaultWorkspace: string;
  dockerAgentWorkspace: string;
  agentId: string;
  model: string;
  telegramEnv: string;
  telegramToken: string;
  commands: SystemAgentFirstRunCommand[];
  auditOperations: string[];
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function setEnvValue(key: string, value: string): void {
  Reflect.set(process.env, key, value);
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

async function readFirstRunSpec(): Promise<SystemAgentFirstRunSpec> {
  return JSON.parse(
    await fs.readFile(
      path.join(process.cwd(), "scripts", "e2e", "system-agent-first-run-spec.json"),
      "utf8",
    ),
  ) as SystemAgentFirstRunSpec;
}

function renderCommandTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, key: string) => vars[key] ?? match);
}

const FAKE_PLANNER_REPLY = "Fake Claude planner selected an inference-backed typed setup.";
const PACKAGED_CLI_TIMEOUT_MS = 60_000;
const INFERENCE_PROBE_PROMPT = "Reply with the single word OK";

async function readFakeClaudePromptLines(promptLogPath: string): Promise<string[]> {
  return (await fs.readFile(promptLogPath, "utf8"))
    .split("\n")
    .filter((line) => line.trim().length > 0);
}

function countInferencePrompts(lines: string[]): number {
  return lines.filter((line) => line.includes(INFERENCE_PROBE_PROMPT)).length;
}

function resolveDefaultModel(config: OpenClawConfig): string | undefined {
  const model = config.agents?.defaults?.model;
  return typeof model === "string" ? model : model?.primary;
}

async function installFakeClaudeCli(
  fakeBinDir: string,
  promptLogPath: string,
  plannerCommand: string,
): Promise<void> {
  await fs.mkdir(fakeBinDir, { recursive: true });
  const packageRoot = path.dirname(fakeBinDir);
  const scriptPath = path.join(fakeBinDir, "claude");
  const plannerResult = JSON.stringify({
    reply: FAKE_PLANNER_REPLY,
    command: plannerCommand,
  });
  await fs.writeFile(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify({
      name: "@anthropic-ai/claude-code",
      version: "99.0.0",
      private: true,
      bin: { claude: "bin/claude" },
    })}\n`,
  );
  await fs.writeFile(
    scriptPath,
    [
      `#!${process.execPath}`,
      'const fs = require("node:fs");',
      'if (process.argv[2] === "--version") {',
      '  console.log("claude 99.0.0");',
      "  process.exit(0);",
      "}",
      `const promptLogPath = ${JSON.stringify(promptLogPath)};`,
      `const plannerResult = ${JSON.stringify(plannerResult)};`,
      'const promptLine = fs.readFileSync(0, "utf8").split(/\\r?\\n/u, 1)[0] ?? "";',
      'fs.appendFileSync(promptLogPath, `${promptLine}\\n`, "utf8");',
      'const result = promptLine.includes("User request:") ? plannerResult : "OK";',
      "console.log(",
      "  JSON.stringify({",
      '    type: "result",',
      '    session_id: "fake-claude-session",',
      "    result,",
      "    usage: { input_tokens: 1, output_tokens: 1 },",
      "  }),",
      ");",
    ].join("\n"),
    { mode: 0o755 },
  );
  await fs.chmod(scriptPath, 0o755);
}

async function runPackagedCli(args: string[]): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  const child = spawn("openclaw", args, {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, PACKAGED_CLI_TIMEOUT_MS);
  let code: number | null;
  try {
    code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
  } finally {
    clearTimeout(timeout);
  }
  if (timedOut) {
    throw new Error(
      `Packaged CLI timed out after ${PACKAGED_CLI_TIMEOUT_MS}ms: openclaw ${args.join(" ")}\n${stdout}\n${stderr}`,
    );
  }
  return { code, stdout, stderr };
}

async function main() {
  const spec = await readFirstRunSpec();
  const tempState = await createE2eStateDir("openclaw-system-agent-first-run-");
  tempState.registerExitCleanup();
  const stateDir = tempState.stateDir;
  const configPath = process.env.OPENCLAW_CONFIG_PATH ?? path.join(stateDir, "openclaw.json");
  // Keep mutable logs/config outside the hashed package tree. Every file below
  // this root is part of the durable CLI owner checked before persistent setup.
  const fakeBinDir = path.join(stateDir, "fake-claude-package", "bin");
  const promptLogPath = path.join(stateDir, "fake-claude-prompts.jsonl");
  setEnvValue("OPENCLAW_STATE_DIR", stateDir);
  setEnvValue("OPENCLAW_CONFIG_PATH", configPath);
  setEnvValue("PATH", `${fakeBinDir}:${process.env.PATH ?? ""}`);
  Reflect.deleteProperty(process.env, "OPENAI_API_KEY");
  Reflect.deleteProperty(process.env, "ANTHROPIC_API_KEY");
  await fs.rm(stateDir, { recursive: true, force: true });
  await fs.mkdir(stateDir, { recursive: true });

  clearConfigCache();
  assert(
    await shouldStartOnboardingForFreshInstall(["node", "openclaw"]),
    "fresh bare OpenClaw invocation did not route to onboarding",
  );

  const blocked = await runPackagedCli(["setup", "--message", "overview"]);
  assert(blocked.code === 1, "OpenClaw did not fail closed without inference");
  assert(
    `${blocked.stdout}\n${blocked.stderr}`.includes("openclaw onboard"),
    "blocked OpenClaw did not direct the user to inference onboarding",
  );
  const blockedModern = await runPackagedCli([
    "onboard",
    "--modern",
    "--non-interactive",
    "--accept-risk",
    "--json",
  ]);
  assert(
    blockedModern.code === 1 &&
      `${blockedModern.stdout}\n${blockedModern.stderr}`.includes('"ok": false'),
    "modern compatibility entrypoint did not fail closed with structured JSON",
  );

  const plannerCommand = `setup workspace ${spec.dockerDefaultWorkspace}`;
  await installFakeClaudeCli(fakeBinDir, promptLogPath, plannerCommand);
  const activationRuntime = createRuntime();
  const activation = await activateSetupInference({
    kind: "claude-cli",
    workspace: spec.dockerDefaultWorkspace,
    surface: "cli",
    runtime: activationRuntime.runtime,
  });
  assert(activation.ok, `fake Claude inference activation failed: ${JSON.stringify(activation)}`);
  assert(
    activation.modelRef === "claude-cli/claude-opus-4-8",
    `activation selected the wrong model: ${activation.modelRef}`,
  );
  const inferenceConfig = JSON.parse(await fs.readFile(configPath, "utf8")) as OpenClawConfig;
  assert(
    resolveDefaultModel(inferenceConfig) === activation.modelRef,
    "activation did not persist the verified inference route",
  );
  assert(
    inferenceConfig.agents?.defaults?.workspace === undefined &&
      inferenceConfig.gateway === undefined,
    "inference activation configured the rest before OpenClaw started",
  );
  const activationPrompts = await fs.readFile(promptLogPath, "utf8");
  assert(
    activationPrompts.includes(INFERENCE_PROBE_PROMPT),
    "inference activation did not send the live model probe",
  );

  const modern = await runPackagedCli([
    "onboard",
    "--modern",
    "--non-interactive",
    "--accept-risk",
    "--json",
  ]);
  assert(
    modern.code === 0 && `${modern.stdout}\n${modern.stderr}`.includes(activation.modelRef),
    "modern compatibility entrypoint did not expose OpenClaw after activation",
  );

  const overview = await runPackagedCli(["setup", "--message", "overview"]);
  const overviewOutput = `${overview.stdout}\n${overview.stderr}`;
  assert(overview.code === 0, `verified OpenClaw CLI failed: ${overviewOutput}`);
  assert(
    overviewOutput.includes("claude-cli/claude-opus-4-8"),
    "verified overview did not report the activated model",
  );

  setEnvValue(spec.telegramEnv, spec.telegramToken);

  const commandVars = {
    defaultWorkspace: spec.dockerDefaultWorkspace,
    agentWorkspace: spec.dockerAgentWorkspace,
    agentId: spec.agentId,
    model: spec.model,
    telegramEnv: spec.telegramEnv,
  };
  for (const command of spec.commands) {
    const message = renderCommandTemplate(command.message, commandVars);
    const probesBefore = countInferencePrompts(await readFakeClaudePromptLines(promptLogPath));
    const result = await runPackagedCli([
      "setup",
      "--message",
      message,
      ...(command.approve ? ["--yes"] : []),
    ]);
    const output = `${result.stdout}\n${result.stderr}`;
    assert(
      result.code === 0 && output.includes(command.expectOutput),
      `OpenClaw first-run command ${command.id} did not apply: ${output}`,
    );
    if (command.planner) {
      assert(
        output.includes(`[openclaw] planner: ${spec.model}`) &&
          output.includes(FAKE_PLANNER_REPLY) &&
          output.includes(`[openclaw] interpreted: ${plannerCommand}`),
        `OpenClaw first-run command ${command.id} did not use the verified planner: ${output}`,
      );
    }
    const probesAfter = countInferencePrompts(await readFakeClaudePromptLines(promptLogPath));
    const probeDelta = probesAfter - probesBefore;
    const minimumProbes = command.approve ? 2 : 1;
    assert(
      probeDelta >= minimumProbes,
      `OpenClaw command ${command.id} ran ${probeDelta} inference probes; expected at least ${minimumProbes} for preflight${command.approve ? " plus its persistent boundary" : ""}`,
    );
  }

  const pluginList = await runPackagedCli(["plugins", "list", "--json"]);
  assert(
    pluginList.code === 0,
    `packaged plugin listing failed: ${pluginList.stdout}\n${pluginList.stderr}`,
  );
  const pluginReport = JSON.parse(pluginList.stdout) as {
    plugins?: Array<{ id?: string; enabled?: boolean }>;
  };
  const telegramPlugin = pluginReport.plugins?.find((plugin) => plugin.id === "telegram");
  assert(
    telegramPlugin?.enabled === true,
    "Telegram channel config did not auto-enable the packaged Telegram plugin",
  );

  const probeLines = await readFakeClaudePromptLines(promptLogPath);
  const inferencePrompts = probeLines.filter((line) => line.includes(INFERENCE_PROBE_PROMPT));
  const plannerPrompts = probeLines.filter((line) => line.includes("User request:"));
  const minimumEntryAndActivationProbes = spec.commands.length + 4;
  const minimumPersistentBoundaryProbes = spec.auditOperations.length;
  assert(
    inferencePrompts.length >= minimumEntryAndActivationProbes + minimumPersistentBoundaryProbes,
    `expected activation/preflight probes plus at least ${minimumPersistentBoundaryProbes} persistent-boundary probes; got ${inferencePrompts.length}`,
  );
  assert(
    plannerPrompts.length === 1 && plannerPrompts[0]?.includes("finish basic setup"),
    `expected one fuzzy setup planner prompt; got ${plannerPrompts.length}`,
  );
  assert(
    probeLines.length === inferencePrompts.length + plannerPrompts.length,
    `unexpected fake Claude prompt count: ${probeLines.length}`,
  );

  const config = JSON.parse(await fs.readFile(configPath, "utf8")) as OpenClawConfig;
  assert(
    config.agents?.defaults?.workspace === spec.dockerDefaultWorkspace,
    "first-run setup did not write default workspace",
  );
  assert(resolveDefaultModel(config) === spec.model, "first-run setup did not write default model");
  const reef = config.agents?.list?.find((agent) => agent.id === spec.agentId);
  assert(reef, "OpenClaw did not create reef agent");
  assert(reef.workspace === spec.dockerAgentWorkspace, "OpenClaw did not write reef workspace");
  assert(
    reef.model === undefined,
    "OpenClaw wrote a per-agent model instead of inheriting the verified default",
  );
  assert(config.channels?.telegram?.enabled === true, "OpenClaw did not enable Telegram");
  const telegramToken = config.channels?.telegram?.botToken;
  assert(
    telegramToken &&
      typeof telegramToken === "object" &&
      "source" in telegramToken &&
      telegramToken.source === "env" &&
      "id" in telegramToken &&
      telegramToken.id === spec.telegramEnv,
    "OpenClaw did not write Telegram token SecretRef",
  );
  assert(
    !JSON.stringify(config.channels.telegram).includes(spec.telegramToken),
    "OpenClaw persisted the raw Telegram token",
  );

  const auditPath = path.join(stateDir, "audit", "system-agent.jsonl");
  const audit = (await fs.readFile(auditPath, "utf8")).trim();
  for (const operation of spec.auditOperations) {
    assert(audit.includes(`"operation":"${operation}"`), `${operation} audit entry missing`);
  }

  console.log("OpenClaw first-run Docker E2E passed");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
