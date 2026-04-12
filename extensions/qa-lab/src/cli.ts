import type { Command } from "commander";
import { collectString } from "./cli-options.js";
import { LIVE_TRANSPORT_QA_CLI_REGISTRATIONS } from "./live-transports/cli.js";
import type { QaProviderModeInput } from "./run-config.js";
import { hasQaScenarioPack } from "./scenario-catalog.js";

type QaLabCliRuntime = typeof import("./cli.runtime.js");

let qaLabCliRuntimePromise: Promise<QaLabCliRuntime> | null = null;

async function loadQaLabCliRuntime(): Promise<QaLabCliRuntime> {
  qaLabCliRuntimePromise ??= import("./cli.runtime.js");
  return await qaLabCliRuntimePromise;
}

async function runQaSelfCheck(opts: { repoRoot?: string; output?: string }) {
  const runtime = await loadQaLabCliRuntime();
  await runtime.runQaLabSelfCheckCommand(opts);
}

async function runQaSuite(opts: {
  repoRoot?: string;
  outputDir?: string;
  providerMode?: QaProviderModeInput;
  primaryModel?: string;
  alternateModel?: string;
  fastMode?: boolean;
  cliAuthMode?: string;
  parityPack?: string;
  scenarioIds?: string[];
  concurrency?: number;
  runner?: string;
  image?: string;
  cpus?: number;
  memory?: string;
  disk?: string;
}) {
  const runtime = await loadQaLabCliRuntime();
  await runtime.runQaSuiteCommand(opts);
}

async function runQaParityReport(opts: {
  repoRoot?: string;
  candidateSummary: string;
  baselineSummary: string;
  candidateLabel?: string;
  baselineLabel?: string;
  outputDir?: string;
}) {
  const runtime = await loadQaLabCliRuntime();
  await runtime.runQaParityReportCommand(opts);
}
async function runQaCharacterEval(opts: {
  repoRoot?: string;
  outputDir?: string;
  model?: string[];
  scenario?: string;
  fast?: boolean;
  thinking?: string;
  modelThinking?: string[];
  judgeModel?: string[];
  judgeTimeoutMs?: number;
  blindJudgeModels?: boolean;
  concurrency?: number;
  judgeConcurrency?: number;
}) {
  const runtime = await loadQaLabCliRuntime();
  await runtime.runQaCharacterEvalCommand(opts);
}

async function runQaManualLane(opts: {
  repoRoot?: string;
  providerMode?: QaProviderModeInput;
  primaryModel?: string;
  alternateModel?: string;
  fastMode?: boolean;
  message: string;
  timeoutMs?: number;
}) {
  const runtime = await loadQaLabCliRuntime();
  await runtime.runQaManualLaneCommand(opts);
}

async function runQaUi(opts: {
  repoRoot?: string;
  host?: string;
  port?: number;
  advertiseHost?: string;
  advertisePort?: number;
  controlUiUrl?: string;
  controlUiToken?: string;
  controlUiProxyTarget?: string;
  uiDistDir?: string;
  autoKickoffTarget?: string;
  embeddedGateway?: string;
  sendKickoffOnStart?: boolean;
}) {
  const runtime = await loadQaLabCliRuntime();
  await runtime.runQaLabUiCommand(opts);
}

async function runQaDockerScaffold(opts: {
  repoRoot?: string;
  outputDir: string;
  gatewayPort?: number;
  qaLabPort?: number;
  providerBaseUrl?: string;
  image?: string;
  usePrebuiltImage?: boolean;
  bindUiDist?: boolean;
}) {
  const runtime = await loadQaLabCliRuntime();
  await runtime.runQaDockerScaffoldCommand(opts);
}

async function runQaDockerBuildImage(opts: { repoRoot?: string; image?: string }) {
  const runtime = await loadQaLabCliRuntime();
  await runtime.runQaDockerBuildImageCommand(opts);
}

async function runQaDockerUp(opts: {
  repoRoot?: string;
  outputDir?: string;
  gatewayPort?: number;
  qaLabPort?: number;
  providerBaseUrl?: string;
  image?: string;
  usePrebuiltImage?: boolean;
  bindUiDist?: boolean;
  skipUiBuild?: boolean;
}) {
  const runtime = await loadQaLabCliRuntime();
  await runtime.runQaDockerUpCommand(opts);
}

async function runQaMockOpenAi(opts: { host?: string; port?: number }) {
  const runtime = await loadQaLabCliRuntime();
  await runtime.runQaMockOpenAiCommand(opts);
}

export function isQaLabCliAvailable(): boolean {
  return hasQaScenarioPack();
}

export function registerQaLabCli(program: Command) {
  const qa = program
    .command("qa")
    .description("Run private QA automation flows and launch the QA debugger");

  qa.command("run")
    .description("Run the bundled QA self-check and write a Markdown report")
    .option("--repo-root <path>", "Repository root to target when running from a neutral cwd")
    .option("--output <path>", "Report output path")
    .action(async (opts: { repoRoot?: string; output?: string }) => {
      await runQaSelfCheck(opts);
    });

  qa.command("suite")
    .description("Run repo-backed QA scenarios against the QA gateway lane")
    .option("--repo-root <path>", "Repository root to target when running from a neutral cwd")
    .option("--output-dir <path>", "Suite artifact directory")
    .option("--runner <kind>", "Execution runner: host or multipass", "host")
    .option(
      "--provider-mode <mode>",
      "Provider mode: mock-openai or live-frontier (legacy live-openai still works)",
      "mock-openai",
    )
    .option("--model <ref>", "Primary provider/model ref")
    .option("--alt-model <ref>", "Alternate provider/model ref")
    .option(
      "--cli-auth-mode <mode>",
      "CLI backend auth mode for live Claude CLI runs: auto, api-key, or subscription",
    )
    .option("--parity-pack <name>", 'Preset scenario pack; currently only "agentic" is supported')
    .option("--scenario <id>", "Run only the named QA scenario (repeatable)", collectString, [])
    .option("--concurrency <count>", "Scenario worker concurrency", (value: string) =>
      Number(value),
    )
    .option("--fast", "Enable provider fast mode where supported", false)
    .option("--image <alias>", "Multipass image alias")
    .option("--cpus <count>", "Multipass vCPU count", (value: string) => Number(value))
    .option("--memory <size>", "Multipass memory size")
    .option("--disk <size>", "Multipass disk size")
    .action(
      async (opts: {
        repoRoot?: string;
        outputDir?: string;
        runner?: string;
        providerMode?: QaProviderModeInput;
        model?: string;
        altModel?: string;
        cliAuthMode?: string;
        parityPack?: string;
        scenario?: string[];
        concurrency?: number;
        fast?: boolean;
        image?: string;
        cpus?: number;
        memory?: string;
        disk?: string;
      }) => {
        await runQaSuite({
          repoRoot: opts.repoRoot,
          outputDir: opts.outputDir,
          runner: opts.runner,
          providerMode: opts.providerMode,
          primaryModel: opts.model,
          alternateModel: opts.altModel,
          fastMode: opts.fast,
          cliAuthMode: opts.cliAuthMode,
          parityPack: opts.parityPack,
          scenarioIds: opts.scenario,
          concurrency: opts.concurrency,
          image: opts.image,
          cpus: opts.cpus,
          memory: opts.memory,
          disk: opts.disk,
        });
      },
    );

  qa.command("parity-report")
    .description("Compare two QA suite summaries and write an agentic parity gate report")
    .requiredOption("--candidate-summary <path>", "Candidate qa-suite-summary.json path")
    .requiredOption("--baseline-summary <path>", "Baseline qa-suite-summary.json path")
    .option("--repo-root <path>", "Repository root to target when running from a neutral cwd")
    .option("--candidate-label <label>", "Candidate display label", "openai/gpt-5.4")
    .option("--baseline-label <label>", "Baseline display label", "anthropic/claude-opus-4-6")
    .option("--output-dir <path>", "Artifact directory for the parity report")
    .action(
      async (opts: {
        repoRoot?: string;
        candidateSummary: string;
        baselineSummary: string;
        candidateLabel?: string;
        baselineLabel?: string;
        outputDir?: string;
      }) => {
        await runQaParityReport(opts);
      },
    );

  for (const lane of LIVE_TRANSPORT_QA_CLI_REGISTRATIONS) {
    lane.register(qa);
  }

  qa.command("character-eval")
    .description("Run the character QA scenario across live models and write a judged report")
    .option("--repo-root <path>", "Repository root to target when running from a neutral cwd")
    .option("--output-dir <path>", "Character eval artifact directory")
    .option(
      "--model <ref[,option]>",
      "Provider/model ref to evaluate; options: thinking=<level>, fast, no-fast, fast=<bool>",
      collectString,
      [],
    )
    .option("--scenario <id>", "Character scenario id", "character-vibes-gollum")
    .option("--fast", "Enable provider fast mode for all candidate runs")
    .option(
      "--thinking <level>",
      "Candidate thinking default: off|minimal|low|medium|high|xhigh|adaptive",
    )
    .option(
      "--model-thinking <ref=level>",
      "Deprecated: candidate thinking override for one model ref (repeatable)",
      collectString,
      [],
    )
    .option(
      "--judge-model <ref[,option]>",
      "Judge provider/model ref; options: thinking=<level>, fast, no-fast, fast=<bool> (repeatable)",
      collectString,
      [],
    )
    .option("--judge-timeout-ms <ms>", "Override judge wait timeout", (value: string) =>
      Number(value),
    )
    .option(
      "--blind-judge-models",
      "Hide candidate model refs from judge prompts; reports still map rankings back to real refs",
    )
    .option("--concurrency <count>", "Candidate model run concurrency", (value: string) =>
      Number(value),
    )
    .option("--judge-concurrency <count>", "Judge model run concurrency", (value: string) =>
      Number(value),
    )
    .action(
      async (opts: {
        repoRoot?: string;
        outputDir?: string;
        model?: string[];
        scenario?: string;
        fast?: boolean;
        thinking?: string;
        modelThinking?: string[];
        judgeModel?: string[];
        judgeTimeoutMs?: number;
        blindJudgeModels?: boolean;
        concurrency?: number;
        judgeConcurrency?: number;
      }) => {
        await runQaCharacterEval(opts);
      },
    );

  qa.command("manual")
    .description("Run a one-off QA agent prompt against the selected provider/model lane")
    .requiredOption("--message <text>", "Prompt to send to the QA agent")
    .option("--repo-root <path>", "Repository root to target when running from a neutral cwd")
    .option(
      "--provider-mode <mode>",
      "Provider mode: mock-openai or live-frontier (legacy live-openai still works)",
      "live-frontier",
    )
    .option("--model <ref>", "Primary provider/model ref (defaults by provider mode)")
    .option("--alt-model <ref>", "Alternate provider/model ref")
    .option("--fast", "Enable provider fast mode where supported", false)
    .option("--timeout-ms <ms>", "Override agent.wait timeout", (value: string) => Number(value))
    .action(
      async (opts: {
        message: string;
        repoRoot?: string;
        providerMode?: QaProviderModeInput;
        model?: string;
        altModel?: string;
        fast?: boolean;
        timeoutMs?: number;
      }) => {
        await runQaManualLane({
          repoRoot: opts.repoRoot,
          providerMode: opts.providerMode,
          primaryModel: opts.model,
          alternateModel: opts.altModel,
          fastMode: opts.fast,
          message: opts.message,
          timeoutMs: opts.timeoutMs,
        });
      },
    );

  qa.command("ui")
    .description("Start the private QA debugger UI and local QA bus")
    .option("--repo-root <path>", "Repository root to target when running from a neutral cwd")
    .option("--host <host>", "Bind host", "127.0.0.1")
    .option("--port <port>", "Bind port", (value: string) => Number(value))
    .option("--advertise-host <host>", "Optional public host to advertise in bootstrap payloads")
    .option("--advertise-port <port>", "Optional public port to advertise", (value: string) =>
      Number(value),
    )
    .option("--control-ui-url <url>", "Optional Control UI URL to embed beside the QA panel")
    .option("--control-ui-token <token>", "Optional Control UI token for embedded links")
    .option(
      "--control-ui-proxy-target <url>",
      "Optional upstream Control UI target for /control-ui proxying",
    )
    .option("--ui-dist-dir <path>", "Optional QA Lab UI asset directory override")
    .option("--auto-kickoff-target <kind>", "Kickoff default target (direct or channel)")
    .option("--embedded-gateway <mode>", "Embedded gateway mode hint", "enabled")
    .option(
      "--send-kickoff-on-start",
      "Inject the repo-backed kickoff task when the UI starts",
      false,
    )
    .action(
      async (opts: {
        repoRoot?: string;
        host?: string;
        port?: number;
        advertiseHost?: string;
        advertisePort?: number;
        controlUiUrl?: string;
        controlUiToken?: string;
        controlUiProxyTarget?: string;
        uiDistDir?: string;
        autoKickoffTarget?: string;
        embeddedGateway?: string;
        sendKickoffOnStart?: boolean;
      }) => {
        await runQaUi(opts);
      },
    );

  qa.command("docker-scaffold")
    .description("Write a prebaked Docker scaffold for the QA dashboard + gateway lane")
    .option("--repo-root <path>", "Repository root to target when running from a neutral cwd")
    .requiredOption("--output-dir <path>", "Output directory for docker-compose + state files")
    .option("--gateway-port <port>", "Gateway host port", (value: string) => Number(value))
    .option("--qa-lab-port <port>", "QA lab host port", (value: string) => Number(value))
    .option("--provider-base-url <url>", "Provider base URL for the QA gateway")
    .option("--image <name>", "Prebaked image name", "openclaw:qa-local-prebaked")
    .option("--use-prebuilt-image", "Use image: instead of build: in docker-compose", false)
    .option(
      "--bind-ui-dist",
      "Bind-mount extensions/qa-lab/web/dist into the qa-lab container for faster UI refresh",
      false,
    )
    .action(
      async (opts: {
        repoRoot?: string;
        outputDir: string;
        gatewayPort?: number;
        qaLabPort?: number;
        providerBaseUrl?: string;
        image?: string;
        usePrebuiltImage?: boolean;
        bindUiDist?: boolean;
      }) => {
        await runQaDockerScaffold(opts);
      },
    );

  qa.command("docker-build-image")
    .description("Build the prebaked QA Docker image with qa-channel + qa-lab bundled")
    .option("--repo-root <path>", "Repository root to target when running from a neutral cwd")
    .option("--image <name>", "Image tag", "openclaw:qa-local-prebaked")
    .action(async (opts: { repoRoot?: string; image?: string }) => {
      await runQaDockerBuildImage(opts);
    });

  qa.command("up")
    .description("Build the QA site, start the Docker-backed QA stack, and print the QA Lab URL")
    .option("--repo-root <path>", "Repository root to target when running from a neutral cwd")
    .option("--output-dir <path>", "Output directory for docker-compose + state files")
    .option("--gateway-port <port>", "Gateway host port", (value: string) => Number(value))
    .option("--qa-lab-port <port>", "QA lab host port", (value: string) => Number(value))
    .option("--provider-base-url <url>", "Provider base URL for the QA gateway")
    .option("--image <name>", "Image tag", "openclaw:qa-local-prebaked")
    .option("--use-prebuilt-image", "Use image: instead of build: in docker-compose", false)
    .option(
      "--bind-ui-dist",
      "Bind-mount extensions/qa-lab/web/dist into the qa-lab container for faster UI refresh",
      false,
    )
    .option("--skip-ui-build", "Skip pnpm qa:lab:build before starting Docker", false)
    .action(
      async (opts: {
        repoRoot?: string;
        outputDir?: string;
        gatewayPort?: number;
        qaLabPort?: number;
        providerBaseUrl?: string;
        image?: string;
        usePrebuiltImage?: boolean;
        bindUiDist?: boolean;
        skipUiBuild?: boolean;
      }) => {
        await runQaDockerUp(opts);
      },
    );

  qa.command("mock-openai")
    .description("Run the local mock OpenAI Responses API server for QA")
    .option("--host <host>", "Bind host", "127.0.0.1")
    .option("--port <port>", "Bind port", (value: string) => Number(value))
    .action(async (opts: { host?: string; port?: number }) => {
      await runQaMockOpenAi(opts);
    });
}
