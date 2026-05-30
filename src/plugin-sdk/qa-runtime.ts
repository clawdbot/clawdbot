import fs from "node:fs";
import fsp from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import type { Command } from "commander";
import { formatErrorMessage } from "./error-runtime.js";
import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-runtime.js";
import { resolvePrivateQaBundledPluginsEnv } from "./private-qa-bundled-env.js";
import { runExec } from "./process-runtime.js";
import { fetchWithSsrFGuard } from "./ssrf-runtime.js";
import { normalizeStringEntries } from "./string-coerce-runtime.js";

type QaRuntimeSurface = {
  defaultQaRuntimeModelForMode: (
    mode: string,
    options?: {
      alternate?: boolean;
      preferredLiveModel?: string;
    },
  ) => string;
  startQaLiveLaneGateway: (...args: unknown[]) => Promise<unknown>;
};

function isMissingQaRuntimeError(error: unknown) {
  return (
    error instanceof Error &&
    (error.message === "Unable to resolve bundled plugin public surface qa-lab/runtime-api.js" ||
      error.message.startsWith("Unable to open bundled plugin public surface "))
  );
}

export function loadQaRuntimeModule(): QaRuntimeSurface {
  const env = resolvePrivateQaBundledPluginsEnv();
  return loadBundledPluginPublicSurfaceModuleSync<QaRuntimeSurface>({
    dirName: "qa-lab",
    artifactBasename: "runtime-api.js",
    ...(env ? { env } : {}),
  });
}

export function isQaRuntimeAvailable(): boolean {
  try {
    loadQaRuntimeModule();
    return true;
  } catch (error) {
    if (isMissingQaRuntimeError(error)) {
      return false;
    }
    throw error;
  }
}

export type LiveTransportQaCommandOptions = {
  repoRoot?: string;
  outputDir?: string;
  providerMode?: string;
  primaryModel?: string;
  alternateModel?: string;
  fastMode?: boolean;
  allowFailures?: boolean;
  failFast?: boolean;
  profile?: string;
  scenarioIds?: string[];
  listScenarios?: boolean;
  sutAccountId?: string;
  credentialSource?: string;
  credentialRole?: string;
};

type LiveTransportQaCommanderOptions = {
  repoRoot?: string;
  outputDir?: string;
  providerMode?: string;
  model?: string;
  altModel?: string;
  scenario?: string[];
  listScenarios?: boolean;
  fast?: boolean;
  allowFailures?: boolean;
  failFast?: boolean;
  profile?: string;
  sutAccount?: string;
  credentialSource?: string;
  credentialRole?: string;
};

export type LiveTransportQaCliRegistration = {
  commandName: string;
  register(qa: Command): void;
};

export type LiveTransportQaCredentialCliOptions = {
  sourceDescription?: string;
  roleDescription?: string;
};

export type LiveTransportQaCliRegistrationOptions = {
  commandName: string;
  credentialOptions?: LiveTransportQaCredentialCliOptions;
  defaultProviderMode: string;
  description: string;
  providerModeHelp: string;
  listScenariosHelp?: string;
  outputDirHelp: string;
  profileHelp?: string;
  failFastHelp?: string;
  allowFailuresHelp?: string;
  scenarioHelp: string;
  sutAccountHelp: string;
  run: (opts: LiveTransportQaCommandOptions) => Promise<void>;
};

export function createLazyCliRuntimeLoader<T>(load: () => Promise<T>) {
  let promise: Promise<T> | null = null;
  return async () => {
    promise ??= load();
    return await promise;
  };
}

function collectLiveTransportQaStringOption(value: string, previous: string[]) {
  const trimmed = value.trim();
  return trimmed ? [...previous, trimmed] : previous;
}

function mapLiveTransportQaCommanderOptions(
  opts: LiveTransportQaCommanderOptions,
): LiveTransportQaCommandOptions {
  return {
    repoRoot: opts.repoRoot,
    outputDir: opts.outputDir,
    providerMode: opts.providerMode,
    primaryModel: opts.model,
    alternateModel: opts.altModel,
    fastMode: opts.fast,
    allowFailures: opts.allowFailures,
    failFast: opts.failFast,
    profile: opts.profile,
    scenarioIds: opts.scenario,
    listScenarios: opts.listScenarios,
    sutAccountId: opts.sutAccount,
    credentialSource: opts.credentialSource,
    credentialRole: opts.credentialRole,
  };
}

function registerLiveTransportQaCli(
  params: LiveTransportQaCliRegistrationOptions & {
    qa: Command;
  },
) {
  const command = params.qa
    .command(params.commandName)
    .description(params.description)
    .option("--repo-root <path>", "Repository root to target when running from a neutral cwd")
    .option("--output-dir <path>", params.outputDirHelp)
    .option("--provider-mode <mode>", params.providerModeHelp, params.defaultProviderMode)
    .option("--model <ref>", "Primary provider/model ref")
    .option("--alt-model <ref>", "Alternate provider/model ref")
    .option("--scenario <id>", params.scenarioHelp, collectLiveTransportQaStringOption, [])
    .option("--fast", "Enable provider fast mode where supported", false);

  if (params.allowFailuresHelp) {
    command.option("--allow-failures", params.allowFailuresHelp, false);
  }

  command.option("--sut-account <id>", params.sutAccountHelp, "sut");

  if (params.listScenariosHelp) {
    command.option("--list-scenarios", params.listScenariosHelp, false);
  }

  if (params.profileHelp) {
    command.option("--profile <profile>", params.profileHelp);
  }

  if (params.failFastHelp) {
    command.option("--fail-fast", params.failFastHelp, false);
  }

  if (params.credentialOptions) {
    command.option(
      "--credential-source <source>",
      params.credentialOptions.sourceDescription ??
        "Credential source for live lanes: env or convex (default: env)",
    );
    if (params.credentialOptions.roleDescription) {
      command.option("--credential-role <role>", params.credentialOptions.roleDescription);
    }
  }

  command.action(async (opts: LiveTransportQaCommanderOptions) => {
    await params.run(mapLiveTransportQaCommanderOptions(opts));
  });
}

export function createLiveTransportQaCliRegistration(
  params: LiveTransportQaCliRegistrationOptions,
): LiveTransportQaCliRegistration {
  return {
    commandName: params.commandName,
    register(qa: Command) {
      registerLiveTransportQaCli({
        ...params,
        qa,
      });
    },
  };
}

export type QaReportCheck = {
  name: string;
  status: "pass" | "fail" | "skip";
  details?: string;
};

export type QaReportScenario = {
  name: string;
  status: "pass" | "fail" | "skip";
  details?: string;
  steps?: QaReportCheck[];
};

export {
  LIVE_TRANSPORT_BASELINE_STANDARD_SCENARIO_IDS,
  collectLiveTransportStandardScenarioCoverage,
  findMissingLiveTransportStandardScenarios,
  selectLiveTransportScenarios,
  type LiveTransportScenarioDefinition,
  type LiveTransportStandardScenarioId,
} from "./qa-live-transport-scenarios.js";

export type QaDockerRunCommand = (
  command: string,
  args: string[],
  cwd: string,
) => Promise<{ stdout: string; stderr: string }>;

export type QaDockerFetchLike = (input: string) => Promise<{ ok: boolean }>;

const DEFAULT_QA_DOCKER_COMMAND_TIMEOUT_MS = 120_000;

function pushQaReportDetailsBlock(lines: string[], label: string, details: string, indent = "") {
  if (!details.includes("\n")) {
    lines.push(`${indent}- ${label}: ${details}`);
    return;
  }
  lines.push(`${indent}- ${label}:`);
  lines.push("", "```text", details, "```");
}

export function renderQaMarkdownReport(params: {
  title: string;
  startedAt: Date;
  finishedAt: Date;
  checks?: QaReportCheck[];
  scenarios?: QaReportScenario[];
  timeline?: string[];
  notes?: string[];
}) {
  const checks = params.checks ?? [];
  const scenarios = params.scenarios ?? [];
  const passCount =
    checks.filter((check) => check.status === "pass").length +
    scenarios.filter((scenario) => scenario.status === "pass").length;
  const failCount =
    checks.filter((check) => check.status === "fail").length +
    scenarios.filter((scenario) => scenario.status === "fail").length;

  const lines = [
    `# ${params.title}`,
    "",
    `- Started: ${params.startedAt.toISOString()}`,
    `- Finished: ${params.finishedAt.toISOString()}`,
    `- Duration ms: ${params.finishedAt.getTime() - params.startedAt.getTime()}`,
    `- Passed: ${passCount}`,
    `- Failed: ${failCount}`,
    "",
  ];

  if (checks.length > 0) {
    lines.push("## Checks", "");
    for (const check of checks) {
      lines.push(`- [${check.status === "pass" ? "x" : " "}] ${check.name}`);
      if (check.details) {
        pushQaReportDetailsBlock(lines, "Details", check.details, "  ");
      }
    }
  }

  if (scenarios.length > 0) {
    lines.push("", "## Scenarios", "");
    for (const scenario of scenarios) {
      lines.push(`### ${scenario.name}`);
      lines.push("");
      lines.push(`- Status: ${scenario.status}`);
      if (scenario.details) {
        pushQaReportDetailsBlock(lines, "Details", scenario.details);
      }
      if (scenario.steps?.length) {
        lines.push("- Steps:");
        for (const step of scenario.steps) {
          lines.push(`  - [${step.status === "pass" ? "x" : " "}] ${step.name}`);
          if (step.details) {
            pushQaReportDetailsBlock(lines, "Details", step.details, "    ");
          }
        }
      }
      lines.push("");
    }
  }

  if (params.timeline && params.timeline.length > 0) {
    lines.push("## Timeline", "");
    for (const item of params.timeline) {
      lines.push(`- ${item}`);
    }
  }

  if (params.notes && params.notes.length > 0) {
    lines.push("", "## Notes", "");
    for (const note of params.notes) {
      lines.push(`- ${note}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

export function appendQaLiveLaneIssue(issues: string[], label: string, error: unknown) {
  issues.push(`${label}: ${formatErrorMessage(error)}`);
}

export function buildQaLiveLaneArtifactsError(params: {
  heading: string;
  artifacts: Record<string, string>;
  details?: string[];
}) {
  return [
    params.heading,
    ...(params.details ?? []),
    "Artifacts:",
    ...Object.entries(params.artifacts).map(([label, filePath]) => `- ${label}: ${filePath}`),
  ].join("\n");
}

export function printLiveTransportQaArtifacts(
  laneLabel: string,
  artifacts: Record<string, string>,
) {
  for (const [label, filePath] of Object.entries(artifacts)) {
    process.stdout.write(`${laneLabel} ${label}: ${filePath}\n`);
  }
}

function describeQaDockerError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return JSON.stringify(error);
}

async function isQaDockerPortFree(port: number) {
  return await new Promise<boolean>((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

async function findFreeQaDockerPort() {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to find free port"));
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });
}

export async function resolveQaDockerHostPort(preferredPort: number, pinned: boolean) {
  if (pinned || (await isQaDockerPortFree(preferredPort))) {
    return preferredPort;
  }
  return await findFreeQaDockerPort();
}

function trimQaDockerCommandOutput(output: string) {
  const trimmed = output.trim();
  if (!trimmed) {
    return "";
  }
  const lines = trimmed.split("\n");
  return lines.length <= 120 ? trimmed : lines.slice(-120).join("\n");
}

function renderQaDockerCommandFailure(command: string, args: string[], error: unknown) {
  const failedProcess = error as Error & { stdout?: string; stderr?: string };
  const renderedStdout = trimQaDockerCommandOutput(failedProcess.stdout ?? "");
  const renderedStderr = trimQaDockerCommandOutput(failedProcess.stderr ?? "");
  return new Error(
    [
      `Command failed: ${[command, ...args].join(" ")}`,
      renderedStderr ? `stderr:\n${renderedStderr}` : "",
      renderedStdout ? `stdout:\n${renderedStdout}` : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
    { cause: error },
  );
}

function normalizeDockerServiceStatus(row?: { Health?: string; State?: string }) {
  const health = row?.Health?.trim();
  if (health) {
    return health;
  }
  const state = row?.State?.trim();
  if (state) {
    return state;
  }
  return "unknown";
}

function parseDockerComposePsRows(stdout: string) {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return [] as Array<{ Health?: string; State?: string }>;
  }

  try {
    const parsed = JSON.parse(trimmed) as
      | Array<{ Health?: string; State?: string }>
      | { Health?: string; State?: string };
    if (Array.isArray(parsed)) {
      return parsed;
    }
    return [parsed];
  } catch {
    return normalizeStringEntries(trimmed.split("\n")).map(
      (line) => JSON.parse(line) as { Health?: string; State?: string },
    );
  }
}

async function isQaDockerHealthy(url: string, fetchImpl: QaDockerFetchLike) {
  try {
    const response = await fetchImpl(url);
    return response.ok;
  } catch {
    return false;
  }
}

export function createQaDockerRuntime(params: {
  auditContext: string;
  commandTimeoutMs?: number | null;
}) {
  const commandTimeoutMs =
    params.commandTimeoutMs === undefined
      ? DEFAULT_QA_DOCKER_COMMAND_TIMEOUT_MS
      : params.commandTimeoutMs;

  const fetchHealthUrl = async (url: string): Promise<{ ok: boolean }> => {
    const { response, release } = await fetchWithSsrFGuard({
      url,
      init: {
        signal: AbortSignal.timeout(2_000),
      },
      policy: { allowPrivateNetwork: true },
      auditContext: params.auditContext,
    });
    try {
      return { ok: response.ok };
    } finally {
      await release();
    }
  };

  const execCommand: QaDockerRunCommand = async (command, args, cwd) => {
    try {
      return await runExec(command, args, {
        cwd,
        maxBuffer: 10 * 1024 * 1024,
        ...(commandTimeoutMs === null ? {} : { timeoutMs: commandTimeoutMs }),
      });
    } catch (error) {
      throw renderQaDockerCommandFailure(command, args, error);
    }
  };

  const waitForHealth = async (
    url: string,
    deps: {
      label?: string;
      composeFile?: string;
      fetchImpl: QaDockerFetchLike;
      sleepImpl: (ms: number) => Promise<unknown>;
      timeoutMs?: number;
      pollMs?: number;
    },
  ) => {
    const timeoutMs = deps.timeoutMs ?? 360_000;
    const pollMs = deps.pollMs ?? 1_000;
    const startMs = Date.now();
    const deadline = startMs + timeoutMs;
    let lastError: unknown = null;

    while (Date.now() < deadline) {
      try {
        const response = await deps.fetchImpl(url);
        if (response.ok) {
          return;
        }
        lastError = new Error(`Health check returned non-OK for ${url}`);
      } catch (error) {
        lastError = error;
      }
      await deps.sleepImpl(pollMs);
    }

    const elapsedSec = Math.round((Date.now() - startMs) / 1000);
    const service = deps.label ?? url;
    const lines = [
      `${service} did not become healthy within ${elapsedSec}s (limit ${Math.round(timeoutMs / 1000)}s).`,
      lastError ? `Last error: ${describeQaDockerError(lastError)}` : "",
      `Hint: check container logs with \`docker compose -f ${deps.composeFile ?? "<compose-file>"} logs\` and verify the port is not already in use.`,
    ];
    throw new Error(lines.filter(Boolean).join("\n"));
  };

  const waitForDockerServiceHealth = async (
    service: string,
    composeFile: string,
    repoRoot: string,
    runCommand: QaDockerRunCommand,
    sleepImpl: (ms: number) => Promise<unknown>,
    timeoutMs = 360_000,
    pollMs = 1_000,
  ) => {
    const startMs = Date.now();
    const deadline = startMs + timeoutMs;
    let lastStatus = "unknown";

    while (Date.now() < deadline) {
      try {
        const { stdout } = await runCommand(
          "docker",
          ["compose", "-f", composeFile, "ps", "--format", "json", service],
          repoRoot,
        );
        const row = parseDockerComposePsRows(stdout)[0];
        lastStatus = normalizeDockerServiceStatus(row);
        if (lastStatus === "healthy" || lastStatus === "running") {
          return;
        }
      } catch (error) {
        lastStatus = describeQaDockerError(error);
      }
      await sleepImpl(pollMs);
    }

    const elapsedSec = Math.round((Date.now() - startMs) / 1000);
    throw new Error(
      [
        `${service} did not become healthy within ${elapsedSec}s (limit ${Math.round(timeoutMs / 1000)}s).`,
        `Last status: ${lastStatus}`,
        `Hint: check container logs with \`docker compose -f ${composeFile} logs ${service}\`.`,
      ].join("\n"),
    );
  };

  const resolveComposeServiceUrl = async (
    service: string,
    port: number,
    composeFile: string,
    repoRoot: string,
    runCommand: QaDockerRunCommand,
    fetchImpl?: QaDockerFetchLike,
  ) => {
    const { stdout: containerStdout } = await runCommand(
      "docker",
      ["compose", "-f", composeFile, "ps", "-q", service],
      repoRoot,
    );
    const containerId = containerStdout.trim();
    if (!containerId) {
      return null;
    }
    const { stdout: ipStdout } = await runCommand(
      "docker",
      [
        "inspect",
        "--format",
        "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
        containerId,
      ],
      repoRoot,
    );
    const ip = ipStdout.trim();
    if (!ip) {
      return null;
    }
    const baseUrl = `http://${ip}:${port}/`;
    if (!fetchImpl) {
      return baseUrl;
    }
    return (await isQaDockerHealthy(`${baseUrl}healthz`, fetchImpl)) ? baseUrl : null;
  };

  return {
    execCommand,
    fetchHealthUrl,
    resolveComposeServiceUrl,
    resolveHostPort: resolveQaDockerHostPort,
    waitForDockerServiceHealth,
    waitForHealth,
  };
}

type ProcessWriteCallback = (err?: Error | null) => void;

export async function startLiveTransportQaOutputTee(params: {
  fileName: string;
  outputDir: string;
}) {
  await fsp.mkdir(params.outputDir, { recursive: true });
  const outputPath = path.join(params.outputDir, params.fileName);
  const output = fs.createWriteStream(outputPath, {
    encoding: "utf8",
    flags: "a",
    mode: 0o600,
  });
  let outputError: Error | null = null;
  output.on("error", (error) => {
    outputError ??= error;
  });
  const originalStdoutWrite = Reflect.get(process.stdout, "write");
  const originalStderrWrite = Reflect.get(process.stderr, "write");
  const boundStdoutWrite = originalStdoutWrite.bind(process.stdout);
  const boundStderrWrite = originalStderrWrite.bind(process.stderr);
  let stopped = false;

  const tee = (originalWrite: typeof process.stdout.write) =>
    function writeWithTee(
      this: NodeJS.WriteStream,
      chunk: string | Uint8Array,
      encodingOrCallback?: BufferEncoding | ProcessWriteCallback,
      callback?: ProcessWriteCallback,
    ) {
      if (!stopped && !outputError) {
        output.write(chunk);
      }
      return Reflect.apply(originalWrite, this, [chunk, encodingOrCallback, callback]) as boolean;
    };

  process.stdout.write = tee(boundStdoutWrite) as typeof process.stdout.write;
  process.stderr.write = tee(boundStderrWrite) as typeof process.stderr.write;

  return {
    outputPath,
    async stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
      if (outputError) {
        throw outputError;
      }
      await new Promise<void>((resolve, reject) => {
        output.once("error", reject);
        output.end(resolve);
      });
      if (outputError) {
        throw outputError;
      }
    },
  };
}
