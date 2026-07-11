// Qa Lab plugin module implements cli behavior.
import type { Command } from "commander";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import { collectString } from "./cli-options.js";
import type {
  QaLabSelfCheckCommandOptions,
  QaProfileCommandOptions,
  QaSuiteCommandOptions,
} from "./cli.runtime.js";
import { listLiveTransportQaCliRegistrations } from "./live-transports/cli.js";
import { registerMantisCli } from "./mantis/cli.js";
import {
  DEFAULT_QA_LIVE_PROVIDER_MODE,
  formatQaProviderModeHelp,
  listQaStandaloneProviderCommands,
} from "./providers/index.js";
import {
  QA_FRONTIER_PARITY_BASELINE_LABEL,
  QA_FRONTIER_PARITY_CANDIDATE_LABEL,
} from "./providers/live-frontier/parity.js";
import type { QaProviderMode, QaProviderModeInput } from "./run-config.js";
import { hasQaScenarioPack } from "./scenario-catalog.js";

type QaScenarioRunCliOptions = {
  repoRoot?: QaSuiteCommandOptions["repoRoot"];
  outputDir?: QaSuiteCommandOptions["outputDir"];
  transport?: QaSuiteCommandOptions["transportId"];
  providerMode?: QaSuiteCommandOptions["providerMode"];
  model?: QaSuiteCommandOptions["primaryModel"];
  altModel?: QaSuiteCommandOptions["alternateModel"];
  concurrency?: QaSuiteCommandOptions["concurrency"];
  allowFailures?: QaSuiteCommandOptions["allowFailures"];
  fast?: QaSuiteCommandOptions["fastMode"];
};

type QaRunCliOptions = QaLabSelfCheckCommandOptions &
  QaScenarioRunCliOptions & {
    qaProfile?: QaProfileCommandOptions["profile"];
    surface?: QaProfileCommandOptions["surface"];
    category?: QaProfileCommandOptions["category"];
    scenario?: QaProfileCommandOptions["scenarioIds"];
    evidenceMode?: QaProfileCommandOptions["evidenceMode"];
    excludeTestExecutionEvidence?: boolean;
  };

const QA_RUN_PROFILE_ONLY_OPTIONS = [
  { optionName: "outputDir", flag: "--output-dir" },
  { optionName: "surface", flag: "--surface" },
  { optionName: "category", flag: "--category" },
  { optionName: "scenario", flag: "--scenario" },
  { optionName: "evidenceMode", flag: "--evidence-mode" },
  { optionName: "excludeTestExecutionEvidence", flag: "--exclude-test-execution-evidence" },
  { optionName: "transport", flag: "--transport" },
  { optionName: "providerMode", flag: "--provider-mode" },
  { optionName: "model", flag: "--model" },
  { optionName: "altModel", flag: "--alt-model" },
  { optionName: "concurrency", flag: "--concurrency" },
  { optionName: "allowFailures", flag: "--allow-failures" },
  { optionName: "fast", flag: "--fast" },
] as const;

const QA_RUN_SELF_CHECK_ONLY_OPTIONS = [{ optionName: "output", flag: "--output" }] as const;
const MAX_QA_CLI_TCP_PORT = 65_535;

type QaSuiteCliOptions = QaScenarioRunCliOptions & {
  channelDriver?: QaSuiteCommandOptions["channelDriver"];
  channel?: QaSuiteCommandOptions["channel"];
  runner?: QaSuiteCommandOptions["runner"];
  thinking?: QaSuiteCommandOptions["thinking"];
  cliAuthMode?: QaSuiteCommandOptions["cliAuthMode"];
  parityPack?: QaSuiteCommandOptions["parityPack"];
  pack?: QaSuiteCommandOptions["pack"];
  scenario?: QaSuiteCommandOptions["scenarioIds"];
  enablePlugin?: QaSuiteCommandOptions["enabledPluginIds"];
  image?: QaSuiteCommandOptions["image"];
  cpus?: QaSuiteCommandOptions["cpus"];
  memory?: QaSuiteCommandOptions["memory"];
  disk?: QaSuiteCommandOptions["disk"];
  preflight?: QaSuiteCommandOptions["preflight"];
  runtimePair?: QaSuiteCommandOptions["runtimePair"];
  runtimeParityTier?: QaSuiteCommandOptions["runtimeParityTier"];
};

const loadQaLabCliRuntime = createLazyRuntimeModule(() => import("./cli.runtime.js"));

function invalidQaCliArgument(message: string): Error & { code: string; exitCode: number } {
  const error = new Error(message) as Error & { code: string; exitCode: number };
  error.name = "InvalidArgumentError";
  error.code = "commander.invalidArgument";
  error.exitCode = 1;
  return error;
}

function parseQaCliPositiveIntegerOption(value: string, flag: string): number {
  const parsed = parseStrictPositiveInteger(value);
  if (parsed === undefined) {
    throw invalidQaCliArgument(`${flag} must be a positive integer.`);
  }
  return parsed;
}

function parseQaCliTcpPortOption(value: string, flag: string): number {
  const parsed = parseQaCliPositiveIntegerOption(value, flag);
  if (parsed > MAX_QA_CLI_TCP_PORT) {
    throw invalidQaCliArgument(`${flag} must be a TCP port between 1 and 65535.`);
  }
  return parsed;
}

function parseQaEvidenceModeOption(value: string): QaProfileCommandOptions["evidenceMode"] {
  const evidenceMode = value.trim();
  if (evidenceMode === "full" || evidenceMode === "slim") {
    return evidenceMode;
  }
  if (evidenceMode === "compact") {
    return "slim";
  }
  throw invalidQaCliArgument("--evidence-mode must be one of full, slim.");
}

function resolveQaEvidenceModeOptions(opts: QaRunCliOptions) {
  if (opts.excludeTestExecutionEvidence !== true) {
    return opts.evidenceMode;
  }
  if (opts.evidenceMode === "full") {
    throw invalidQaCliArgument(
      "--exclude-test-execution-evidence conflicts with --evidence-mode full.",
    );
  }
  return "slim";
}

function collectCliSuppliedQaRunFlags(
  command: Command,
  options: readonly { optionName: string; flag: string }[],
): string[] {
  return options
    .filter((option) => command.getOptionValueSource(option.optionName) === "cli")
    .map((option) => option.flag);
}

function formatFlagList(flags: readonly string[]): string {
  return flags.length === 1 ? flags[0] : flags.join(", ");
}

function validateQaRunMode(opts: QaRunCliOptions, command: Command) {
  const hasQaProfile = Boolean(opts.qaProfile?.trim());
  if (command.getOptionValueSource("qaProfile") === "cli" && !hasQaProfile) {
    throw new Error("--qa-profile must not be empty.");
  }

  if (hasQaProfile) {
    const selfCheckFlags = collectCliSuppliedQaRunFlags(command, QA_RUN_SELF_CHECK_ONLY_OPTIONS);
    if (selfCheckFlags.length > 0) {
      throw new Error(
        `qa run ${formatFlagList(selfCheckFlags)} is only valid for the self-check mode without --qa-profile.`,
      );
    }
    return;
  }

  const profileFlags = collectCliSuppliedQaRunFlags(command, QA_RUN_PROFILE_ONLY_OPTIONS);
  if (profileFlags.length > 0) {
    throw new Error(
      `qa run ${formatFlagList(profileFlags)} requires --qa-profile; without --qa-profile, qa run only executes the self-check.`,
    );
  }
}

async function runQaSelfCheck(opts: QaLabSelfCheckCommandOptions) {
  const runtime = await loadQaLabCliRuntime();
  await runtime.runQaLabSelfCheckCommand(opts);
}

async function runQaProfile(opts: QaProfileCommandOptions) {
  const runtime = await loadQaLabCliRuntime();
  await runtime.runQaProfileCommand(opts);
}

async function runQaSuiteCliCommand(opts: QaSuiteCommandOptions) {
  const runtime = await loadQaLabCliRuntime();
  await runtime.runQaSuiteCommand(opts);
}

async function runQaParityReport(opts: {
  repoRoot?: string;
  candidateSummary?: string;
  baselineSummary?: string;
  candidateLabel?: string;
  baselineLabel?: string;
  outputDir?: string;
  runtimeAxis?: boolean;
  summary?: string;
  tokenEfficiency?: boolean;
}) {
  const runtime = await loadQaLabCliRuntime();
  await runtime.runQaParityReportCommand(opts);
}

async function runQaConfidenceReport(opts: {
  repoRoot?: string;
  manifest: string;
  artifactRoot?: string;
  outputDir?: string;
  strictZeroUnknowns?: boolean;
  strictGlobalPass?: boolean;
}) {
  const runtime = await loadQaLabCliRuntime();
  await runtime.runQaConfidenceReportCommand(opts);
}

async function runQaConfidenceSelfTest(opts: { repoRoot?: string; outputDir?: string }) {
  const runtime = await loadQaLabCliRuntime();
  await runtime.runQaConfidenceSelfTestCommand(opts);
}

async function runQaCoverageReport(opts: {
  repoRoot?: string;
  output?: string;
  json?: boolean;
  tools?: boolean;
  summary?: string;
  match?: string[];
}) {
  const runtime = await loadQaLabCliRuntime();
  await runtime.runQaCoverageReportCommand(opts);
}

async function runQaJsonlReplay(opts: {
  repoRoot?: string;
  transcripts?: string;
  outputDir?: string;
  runtimePair?: string;
  providerMode?: QaProviderModeInput;
}) {
  const runtime = await loadQaLabCliRuntime();
  await runtime.runQaJsonlReplayCommand(opts);
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
  transportId?: string;
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

async function runQaCredentialsAdd(opts: {
  actorId?: string;
  endpointPrefix?: string;
  json?: boolean;
  kind: string;
  note?: string;
  payloadFile: string;
  repoRoot?: string;
  siteUrl?: string;
}) {
  const runtime = await loadQaLabCliRuntime();
  await runtime.runQaCredentialsAddCommand(opts);
}

async function runQaCredentialsRemove(opts: {
  actorId?: string;
  credentialId: string;
  endpointPrefix?: string;
  json?: boolean;
  siteUrl?: string;
}) {
  const runtime = await loadQaLabCliRuntime();
  await runtime.runQaCredentialsRemoveCommand(opts);
}

async function runQaCredentialsList(opts: {
  actorId?: string;
  endpointPrefix?: string;
  json?: boolean;
  kind?: string;
  limit?: number;
  showSecrets?: boolean;
  siteUrl?: string;
  status?: string;
}) {
  const runtime = await loadQaLabCliRuntime();
  await runtime.runQaCredentialsListCommand(opts);
}

async function runQaCredentialsDoctor(opts: {
  actorId?: string;
  endpointPrefix?: string;
  json?: boolean;
  siteUrl?: string;
}) {
  const runtime = await loadQaLabCliRuntime();
  await runtime.runQaCredentialsDoctorCommand(opts);
}

async function runQaUi(opts: {
  repoRoot?: string;
  host?: string;
  port?: number;
  advertiseHost?: string;
  advertisePort?: number;
  controlUiUrl?: string;
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

async function runQaProviderServer(
  providerMode: QaProviderMode,
  opts: { host?: string; port?: number },
) {
  const runtime = await loadQaLabCliRuntime();
  await runtime.runQaProviderServerCommand(providerMode, opts);
}

export function isQaLabCliAvailable(): boolean {
  return hasQaScenarioPack();
}

function assertNoQaSubcommandCollision(qa: Command, commandName: string) {
  if (qa.commands.some((command) => command.name() === commandName)) {
    throw new Error(`QA runner command "${commandName}" conflicts with an existing qa subcommand`);
  }
}

export function registerQaLabCli(program: Command) {
  const qa = program
    .command("qa")
    .description("Run private QA automation flows and launch the QA debugger");
  registerMantisCli(qa);

  const qaRun = qa
    .command("run")
    .description("Run the bundled QA self-check and write a Markdown report")
    .option("--repo-root <path>", "Repository root to target when running from a neutral cwd")
    .option("--output <path>", "Report output path")
    .option("--output-dir <path>", "Profile run artifact directory")
    .option("--qa-profile <id>", "Run the QA profile from taxonomy.yaml")
    .option("--surface <id>", "Limit --qa-profile to a taxonomy surface id")
    .option("--category <id>", "Limit --qa-profile to a taxonomy category id")
    .option(
      "--scenario <id>",
      "Limit --qa-profile to a scenario id (repeatable)",
      collectString,
      [],
    )
    .option(
      "--evidence-mode <mode>",
      "Set profile qa-evidence.json mode: full or slim",
      parseQaEvidenceModeOption,
    )
    .option(
      "--exclude-test-execution-evidence",
      "Deprecated alias for --evidence-mode slim",
      false,
    );
  qaRun.options.at(-1)?.hideHelp();
  qaRun
    .option("--transport <id>", "QA transport id", "qa-channel")
    .option("--provider-mode <mode>", formatQaProviderModeHelp())
    .option("--model <ref>", "Primary provider/model ref")
    .option("--alt-model <ref>", "Alternate provider/model ref")
    .option("--concurrency <count>", "Scenario worker concurrency", (value: string) =>
      parseQaCliPositiveIntegerOption(value, "--concurrency"),
    )
    .option(
      "--allow-failures",
      "Write artifacts without setting a failing exit code when scenarios fail",
      false,
    )
    .option("--fast", "Enable provider fast mode where supported", false);
  qaRun.action(async (opts: QaRunCliOptions, command: Command) => {
    validateQaRunMode(opts, command);
    if (opts.qaProfile?.trim()) {
      await runQaProfile({
        repoRoot: opts.repoRoot,
        outputDir: opts.outputDir,
        profile: opts.qaProfile,
        surface: opts.surface,
        category: opts.category,
        scenarioIds: opts.scenario,
        evidenceMode: resolveQaEvidenceModeOptions(opts),
        transportId: opts.transport,
        providerMode: opts.providerMode,
        primaryModel: opts.model,
        alternateModel: opts.altModel,
        concurrency: opts.concurrency,
        allowFailures: opts.allowFailures,
        fastMode: opts.fast,
      });
      return;
    }
    await runQaSelfCheck({
      repoRoot: opts.repoRoot,
      output: opts.output,
    });
  });

  qa.command("suite")
    .description("Run repo-backed QA scenarios against the QA gateway lane")
    .option("--repo-root <path>", "Repository root to target when running from a neutral cwd")
    .option("--output-dir <path>", "Suite artifact directory")
    .option("--runner <kind>", "Execution runner: host or multipass", "host")
    .option("--transport <id>", "QA transport id", "qa-channel")
    .option("--channel-driver <id>", "QA channel driver: qa-channel, crabline, or live")
    .option("--channel <id>", "Channel id for --channel-driver crabline or live")
    .option("--provider-mode <mode>", formatQaProviderModeHelp())
    .option("--model <ref>", "Primary provider/model ref")
    .option("--alt-model <ref>", "Alternate provider/model ref")
    .option(
      "--cli-auth-mode <mode>",
      "CLI backend auth mode for live Claude CLI runs: auto, api-key, or subscription",
    )
    .option("--parity-pack <name>", 'Preset scenario pack; currently only "agentic" is supported')
    .option(
      "--pack <id>",
      'Scenario pack id; currently "personal-agent" and "observability" are supported',
    )
    .option("--scenario <id>", "Run only the named QA scenario (repeatable)", collectString, [])
    .option(
      "--enable-plugin <id>",
      "Enable an extra bundled plugin in the QA gateway config (repeatable)",
      collectString,
      [],
    )
    .option("--concurrency <count>", "Scenario worker concurrency", (value: string) =>
      parseQaCliPositiveIntegerOption(value, "--concurrency"),
    )
    .option("--preflight", "Run a single-scenario bootstrap preflight and stop", false)
    .option(
      "--allow-failures",
      "Write artifacts without setting a failing exit code when scenarios fail",
      false,
    )
    .option("--fast", "Enable provider fast mode where supported", false)
    .option(
      "--thinking <level>",
      "Suite thinking default: off|minimal|low|medium|high|xhigh|adaptive|max",
    )
    .option("--image <alias>", "Multipass image alias")
    .option("--cpus <count>", "Multipass vCPU count", (value: string) =>
      parseQaCliPositiveIntegerOption(value, "--cpus"),
    )
    .option("--memory <size>", "Multipass memory size")
    .option("--disk <size>", "Multipass disk size")
    .option("--runtime-pair <pair>", "Run each scenario under both runtimes, e.g. openclaw,codex")
    .option(
      "--runtime-parity-tier <tier>",
      "Add scenarios tagged with runtimeParityTier (standard, optional, live-only, soak; repeatable or comma-separated)",
      collectString,
      [],
    )
    .action(async (opts: QaSuiteCliOptions) => {
      await runQaSuiteCliCommand({
        repoRoot: opts.repoRoot,
        outputDir: opts.outputDir,
        transportId: opts.transport,
        channelDriver: opts.channelDriver,
        channel: opts.channel,
        runner: opts.runner,
        providerMode: opts.providerMode,
        primaryModel: opts.model,
        alternateModel: opts.altModel,
        fastMode: opts.fast,
        thinking: opts.thinking,
        cliAuthMode: opts.cliAuthMode,
        parityPack: opts.parityPack,
        pack: opts.pack,
        scenarioIds: opts.scenario,
        enabledPluginIds: opts.enablePlugin,
        concurrency: opts.concurrency,
        allowFailures: opts.allowFailures,
        image: opts.image,
        cpus: opts.cpus,
        memory: opts.memory,
        disk: opts.disk,
        preflight: opts.preflight,
        runtimePair: opts.runtimePair,
        runtimeParityTier: opts.runtimeParityTier,
      });
    });

  qa.command("parity-report")
    .description("Write either a model-axis parity gate report or a runtime-axis parity report")
    .option("--candidate-summary <path>", "Candidate qa-suite-summary.json path")
    .option("--baseline-summary <path>", "Baseline qa-suite-summary.json path")
    .option("--runtime-axis", "Interpret --summary as a runtime-pair qa-suite-summary.json", false)
    .option("--summary <path>", "Runtime-axis qa-suite-summary.json path")
    .option(
      "--token-efficiency",
      "Also write the runtime token-efficiency report for --runtime-axis summaries",
      false,
    )
    .option("--repo-root <path>", "Repository root to target when running from a neutral cwd")
    .option(
      "--candidate-label <label>",
      "Candidate display label",
      QA_FRONTIER_PARITY_CANDIDATE_LABEL,
    )
    .option("--baseline-label <label>", "Baseline display label", QA_FRONTIER_PARITY_BASELINE_LABEL)
    .option("--output-dir <path>", "Artifact directory for the parity report")
    .action(
      async (opts: {
        repoRoot?: string;
        candidateSummary?: string;
        baselineSummary?: string;
        candidateLabel?: string;
        baselineLabel?: string;
        outputDir?: string;
        runtimeAxis?: boolean;
        summary?: string;
        tokenEfficiency?: boolean;
      }) => {
        await runQaParityReport(opts);
      },
    );

  qa.command("coverage")
    .description("Print the YAML QA coverage inventory")
    .option("--repo-root <path>", "Repository root to target when writing --output")
    .option("--output <path>", "Write the coverage inventory to this path")
    .option("--json", "Print JSON instead of Markdown", false)
    .option("--tools", "Print runtime tool fixture coverage instead of scenario coverage", false)
    .option("--summary <path>", "Runtime qa-suite-summary.json to overlay on --tools coverage")
    .option(
      "--match <query>",
      "Search scenario metadata and print matching scenario refs (repeatable)",
      collectString,
      [],
    )
    .action(
      async (opts: {
        repoRoot?: string;
        output?: string;
        json?: boolean;
        tools?: boolean;
        summary?: string;
        match?: string[];
      }) => {
        await runQaCoverageReport(opts);
      },
    );

  qa.command("confidence-report")
    .description("Classify QA proof artifacts into a zero-unknown confidence report")
    .requiredOption("--manifest <path>", "Confidence profile manifest JSON")
    .option("--repo-root <path>", "Repository root to target when running from a neutral cwd")
    .option("--artifact-root <path>", "Root directory for relative artifact paths", ".")
    .option("--output-dir <path>", "Artifact directory for the confidence report")
    .option(
      "--strict-zero-unknowns",
      "Fail unless every lane passes or has an explicit non-unknown verdict",
      false,
    )
    .option(
      "--strict-global-pass",
      "Fail unless every lane passes with no blocked, missing, unknown, classified-fail, or unbackfilled skipped rows",
      false,
    )
    .action(
      async (opts: {
        repoRoot?: string;
        manifest: string;
        artifactRoot?: string;
        outputDir?: string;
        strictZeroUnknowns?: boolean;
        strictGlobalPass?: boolean;
      }) => {
        await runQaConfidenceReport(opts);
      },
    );

  qa.command("confidence-self-test")
    .description("Write seeded negative-control canaries proving the confidence gate detects drift")
    .option("--repo-root <path>", "Repository root to target when running from a neutral cwd")
    .option("--output-dir <path>", "Artifact directory for the confidence self-test")
    .action(async (opts: { repoRoot?: string; outputDir?: string }) => {
      await runQaConfidenceSelfTest(opts);
    });

  qa.command("jsonl-replay")
    .description("Replay curated JSONL transcripts through the runtime parity replay harness")
    .option("--repo-root <path>", "Repository root to target when running from a neutral cwd")
    .option(
      "--transcripts <path>",
      "Directory of curated JSONL transcripts",
      "qa/scenarios/jsonl-replay",
    )
    .option("--runtime-pair <pair>", "Runtime pair label, e.g. openclaw,codex", "openclaw,codex")
    .option(
      "--provider-mode <mode>",
      `Provider mode (${formatQaProviderModeHelp()})`,
      "mock-openai",
    )
    .option("--output-dir <path>", "Artifact directory for the JSONL replay report")
    .action(
      async (opts: {
        repoRoot?: string;
        transcripts?: string;
        runtimePair?: string;
        providerMode?: QaProviderModeInput;
        outputDir?: string;
      }) => {
        await runQaJsonlReplay(opts);
      },
    );

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
      "Candidate thinking default: off|minimal|low|medium|high|xhigh|adaptive|max",
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
      parseQaCliPositiveIntegerOption(value, "--judge-timeout-ms"),
    )
    .option(
      "--blind-judge-models",
      "Hide candidate model refs from judge prompts; reports still map rankings back to real refs",
    )
    .option("--concurrency <count>", "Candidate model run concurrency", (value: string) =>
      parseQaCliPositiveIntegerOption(value, "--concurrency"),
    )
    .option("--judge-concurrency <count>", "Judge model run concurrency", (value: string) =>
      parseQaCliPositiveIntegerOption(value, "--judge-concurrency"),
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
    .option("--transport <id>", "QA transport id", "qa-channel")
    .option("--provider-mode <mode>", formatQaProviderModeHelp(), DEFAULT_QA_LIVE_PROVIDER_MODE)
    .option("--model <ref>", "Primary provider/model ref (defaults by provider mode)")
    .option("--alt-model <ref>", "Alternate provider/model ref")
    .option("--fast", "Enable provider fast mode where supported", false)
    .option("--timeout-ms <ms>", "Override agent.wait timeout", (value: string) =>
      parseQaCliPositiveIntegerOption(value, "--timeout-ms"),
    )
    .action(
      async (opts: {
        message: string;
        repoRoot?: string;
        transport?: string;
        providerMode?: QaProviderModeInput;
        model?: string;
        altModel?: string;
        fast?: boolean;
        timeoutMs?: number;
      }) => {
        await runQaManualLane({
          repoRoot: opts.repoRoot,
          transportId: opts.transport,
          providerMode: opts.providerMode,
          primaryModel: opts.model,
          alternateModel: opts.altModel,
          fastMode: opts.fast,
          message: opts.message,
          timeoutMs: opts.timeoutMs,
        });
      },
    );

  const credentials = qa
    .command("credentials")
    .description("Manage pooled Convex live credentials used by QA lanes");

  credentials
    .command("doctor")
    .description("Check Convex credential broker env and admin reachability")
    .option("--site-url <url>", "Override OPENCLAW_QA_CONVEX_SITE_URL")
    .option("--endpoint-prefix <path>", "Override OPENCLAW_QA_CONVEX_ENDPOINT_PREFIX")
    .option("--actor-id <id>", "Optional admin actor id to include in broker audit events")
    .option("--json", "Emit machine-readable JSON output", false)
    .action(
      async (opts: {
        siteUrl?: string;
        endpointPrefix?: string;
        actorId?: string;
        json?: boolean;
      }) => {
        await runQaCredentialsDoctor(opts);
      },
    );

  credentials
    .command("add")
    .description("Add one credential payload to the shared pool")
    .requiredOption("--kind <kind>", "Credential kind (for Telegram v1, use telegram)")
    .requiredOption("--payload-file <path>", "JSON object file containing the credential payload")
    .option("--repo-root <path>", "Repository root for resolving relative payload-file paths")
    .option("--note <text>", "Optional note stored with this credential row")
    .option("--site-url <url>", "Override OPENCLAW_QA_CONVEX_SITE_URL")
    .option("--endpoint-prefix <path>", "Override OPENCLAW_QA_CONVEX_ENDPOINT_PREFIX")
    .option("--actor-id <id>", "Optional admin actor id to include in broker audit events")
    .option("--json", "Emit machine-readable JSON output", false)
    .action(
      async (opts: {
        kind: string;
        payloadFile: string;
        repoRoot?: string;
        note?: string;
        siteUrl?: string;
        endpointPrefix?: string;
        actorId?: string;
        json?: boolean;
      }) => {
        await runQaCredentialsAdd(opts);
      },
    );

  credentials
    .command("remove")
    .description("Remove one credential from active use by disabling it")
    .requiredOption("--credential-id <id>", "Credential row id from the Convex pool")
    .option("--site-url <url>", "Override OPENCLAW_QA_CONVEX_SITE_URL")
    .option("--endpoint-prefix <path>", "Override OPENCLAW_QA_CONVEX_ENDPOINT_PREFIX")
    .option("--actor-id <id>", "Optional admin actor id to include in broker audit events")
    .option("--json", "Emit machine-readable JSON output", false)
    .action(
      async (opts: {
        credentialId: string;
        siteUrl?: string;
        endpointPrefix?: string;
        actorId?: string;
        json?: boolean;
      }) => {
        await runQaCredentialsRemove(opts);
      },
    );

  credentials
    .command("list")
    .description("List credential rows in the shared Convex pool")
    .option("--kind <kind>", "Filter by credential kind")
    .option("--status <status>", 'Filter by row status: "active", "disabled", or "all"', "all")
    .option("--limit <count>", "Max rows to return", (value: string) =>
      parseQaCliPositiveIntegerOption(value, "--limit"),
    )
    .option("--show-secrets", "Include credential payload JSON in output", false)
    .option("--site-url <url>", "Override OPENCLAW_QA_CONVEX_SITE_URL")
    .option("--endpoint-prefix <path>", "Override OPENCLAW_QA_CONVEX_ENDPOINT_PREFIX")
    .option("--actor-id <id>", "Optional admin actor id to include in broker audit events")
    .option("--json", "Emit machine-readable JSON output", false)
    .action(
      async (opts: {
        kind?: string;
        status?: string;
        limit?: number;
        showSecrets?: boolean;
        siteUrl?: string;
        endpointPrefix?: string;
        actorId?: string;
        json?: boolean;
      }) => {
        await runQaCredentialsList(opts);
      },
    );

  qa.command("ui")
    .description("Start the private QA debugger UI and local QA bus")
    .option("--repo-root <path>", "Repository root to target when running from a neutral cwd")
    .option("--host <host>", "Bind host", "127.0.0.1")
    .option("--port <port>", "Bind port", (value: string) =>
      parseQaCliTcpPortOption(value, "--port"),
    )
    .option("--advertise-host <host>", "Optional public host to advertise in bootstrap payloads")
    .option("--advertise-port <port>", "Optional public port to advertise", (value: string) =>
      parseQaCliTcpPortOption(value, "--advertise-port"),
    )
    .option("--control-ui-url <url>", "Optional Control UI URL to embed beside the QA panel")
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
    .option("--gateway-port <port>", "Gateway host port", (value: string) =>
      parseQaCliTcpPortOption(value, "--gateway-port"),
    )
    .option("--qa-lab-port <port>", "QA lab host port", (value: string) =>
      parseQaCliTcpPortOption(value, "--qa-lab-port"),
    )
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
    .option("--gateway-port <port>", "Gateway host port", (value: string) =>
      parseQaCliTcpPortOption(value, "--gateway-port"),
    )
    .option("--qa-lab-port <port>", "QA lab host port", (value: string) =>
      parseQaCliTcpPortOption(value, "--qa-lab-port"),
    )
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

  for (const providerCommand of listQaStandaloneProviderCommands()) {
    qa.command(providerCommand.name)
      .description(providerCommand.description)
      .option("--host <host>", "Bind host", "127.0.0.1")
      .option("--port <port>", "Bind port", (value: string) =>
        parseQaCliTcpPortOption(value, "--port"),
      )
      .action(async (opts: { host?: string; port?: number }) => {
        await runQaProviderServer(providerCommand.providerMode, opts);
      });
  }

  for (const lane of listLiveTransportQaCliRegistrations()) {
    assertNoQaSubcommandCollision(qa, lane.commandName);
    lane.register(qa);
  }
}
