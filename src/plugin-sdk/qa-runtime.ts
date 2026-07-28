import fs from "node:fs";
import fsp from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
// QA runtime helpers register and execute plugin QA scenarios from local files.
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import type { Command } from "commander";
import { formatErrorMessage } from "./error-runtime.js";
import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-runtime.js";
import { resolvePrivateQaBundledPluginsEnv } from "./private-qa-bundled-env.js";
import { runExec } from "./process-runtime.js";
import type { QaRunnerCliRegistration } from "./qa-runner-runtime.js";
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

/** Load the bundled QA lab runtime surface, throwing when the private bundle is absent. */
export function loadQaRuntimeModule(): QaRuntimeSurface {
  const env = resolvePrivateQaBundledPluginsEnv();
  return loadBundledPluginPublicSurfaceModuleSync<QaRuntimeSurface>({
    dirName: "qa-lab",
    artifactBasename: "runtime-api.js",
    ...(env ? { env } : {}),
  });
}

/** Check whether the bundled QA lab runtime surface is present without hiding other load errors. */
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

/** Normalized options passed from live-transport QA CLIs into lane runners. */
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

/** Commander registration hook for one live-transport QA subcommand. */
export type LiveTransportQaCliRegistration = QaRunnerCliRegistration;

/** Help text customizations for live credential source and role flags. */
export type LiveTransportQaCredentialCliOptions = {
  sourceDescription?: string;
  roleDescription?: string;
};

/** Declarative command metadata and runner used to install a live-transport QA CLI. */
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
  adapterFactory?: QaRunnerCliRegistration["adapterFactory"];
  run: (opts: LiveTransportQaCommandOptions) => Promise<void>;
};

/** Memoize a lazy CLI runtime import so repeated command paths share one loaded module. */
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
    run: (opts: LiveTransportQaCommandOptions) => Promise<void>;
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

/** Build a Commander registration object for one live-transport QA command. */
export function createLiveTransportQaCliRegistration(
  params: LiveTransportQaCliRegistrationOptions,
): LiveTransportQaCliRegistration {
  return {
    commandName: params.commandName,
    adapterFactory: params.adapterFactory,
    register(qa: Command) {
      registerLiveTransportQaCli({
        ...params,
        qa,
      });
    },
  };
}

/** Docker command runner abstraction used by QA Docker helpers and tests. */
export type QaDockerRunCommand = (
  command: string,
  args: string[],
  cwd: string,
) => Promise<{ stdout: string; stderr: string }>;

/** Minimal fetch-like health probe used by QA Docker runtime helpers. */
export type QaDockerFetchResponse = {
  ok: boolean;
  body?: { cancel?: () => unknown } | null;
};
export type QaDockerFetchLike = (
  input: string,
  init?: Pick<RequestInit, "signal">,
) => Promise<QaDockerFetchResponse>;

const DEFAULT_QA_DOCKER_COMMAND_TIMEOUT_MS = 120_000;
const DEFAULT_QA_DOCKER_HEALTH_REQUEST_TIMEOUT_MS = 2_000;

/** Append a formatted live-lane issue while preserving the caller-owned issue list. */
export function appendQaLiveLaneIssue(issues: string[], label: string, error: unknown) {
  issues.push(`${label}: ${formatErrorMessage(error)}`);
}

/** Format a live-lane failure message that includes artifact labels and paths. */
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

/** Print live-transport QA artifact paths with a lane label for CI log parsers. */
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
    server.listen(0, "127.0.0.1", () => {
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

/** Return the preferred Docker host port unless it is unpinned and already occupied. */
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

function firstDockerOutputLine(stdout: string) {
  return normalizeStringEntries(stdout.split("\n"))[0] ?? "";
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

async function isQaDockerHealthy(
  url: string,
  fetchImpl: QaDockerFetchLike,
  timeoutMs = DEFAULT_QA_DOCKER_HEALTH_REQUEST_TIMEOUT_MS,
) {
  let response: QaDockerFetchResponse | undefined;
  try {
    response = await fetchImpl(url, {
      signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    await releaseQaDockerFetchResponse(response);
  }
}

async function releaseQaDockerFetchResponse(response: QaDockerFetchResponse | undefined) {
  try {
    await response?.body?.cancel?.();
  } catch {}
}

/** Create Docker command, health-check, and compose helpers for QA harnesses. */
export function createQaDockerRuntime(params: {
  auditContext: string;
  commandTimeoutMs?: number | null;
}) {
  const commandTimeoutMs =
    params.commandTimeoutMs === undefined
      ? DEFAULT_QA_DOCKER_COMMAND_TIMEOUT_MS
      : params.commandTimeoutMs;

  const fetchHealthUrl: QaDockerFetchLike = async (url, init) => {
    const { response, release } = await fetchWithSsrFGuard({
      url,
      signal: init?.signal ?? undefined,
      timeoutMs: DEFAULT_QA_DOCKER_HEALTH_REQUEST_TIMEOUT_MS,
      policy: { allowPrivateNetwork: true },
      auditContext: params.auditContext,
    });
    try {
      return { ok: response.ok };
    } finally {
      await releaseQaDockerFetchResponse(response);
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
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        break;
      }
      let response: QaDockerFetchResponse | undefined;
      const requestTimeoutMs = Math.max(
        1,
        Math.min(DEFAULT_QA_DOCKER_HEALTH_REQUEST_TIMEOUT_MS, remainingMs),
      );
      const requestSignal = AbortSignal.timeout(requestTimeoutMs);
      try {
        response = await deps.fetchImpl(url, {
          signal: requestSignal,
        });
        if (response.ok) {
          return;
        }
        lastError = new Error(`Health check returned non-OK for ${url}`);
      } catch (error) {
        lastError = error;
        if (requestSignal.aborted && requestTimeoutMs === remainingMs) {
          break;
        }
      } finally {
        await releaseQaDockerFetchResponse(response);
      }
      const remainingSleepMs = deadline - Date.now();
      if (remainingSleepMs > 0) {
        await deps.sleepImpl(Math.min(pollMs, remainingSleepMs));
      }
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
    const containerId = firstDockerOutputLine(containerStdout);
    if (!containerId) {
      return null;
    }
    const { stdout: ipStdout } = await runCommand(
      "docker",
      [
        "inspect",
        "--format",
        "{{range .NetworkSettings.Networks}}{{println .IPAddress}}{{end}}",
        containerId,
      ],
      repoRoot,
    );
    const ip = firstDockerOutputLine(ipStdout);
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

/** Tee stdout and stderr into a private artifact file until the returned stop hook runs. */
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
        throw toErrorObject(outputError, "Non-Error thrown");
      }
    },
  };
}
